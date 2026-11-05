import { MailService } from '@/modules/admin/system-configs/mail.service';
import { decrypt, encrypt } from '@/common/utils/encryption.util';
import { Role } from '@/common/enums/enum';
import { User } from '@/modules/auth/entities/user.entity';
import { SystemConfig } from '@/modules/admin/system-configs/entities/system-config.entity';
import { SystemConfigsService } from '@/modules/admin/system-configs/system-configs.service';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { signIn } from './helpers/auth';
import { cleanupE2eData, createUser, type TestUser } from './helpers/workspace';

describe('Admin system settings (e2e)', () => {
  let ctx: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let cookie: string;
  let config: SystemConfig;
  const endpoint = '/api/admin/system-configs/settings';
  const password = 'Argus synthetic SMTP credential';
  const readStored = () =>
    ctx.dataSource
      .getRepository(SystemConfig)
      .createQueryBuilder('config')
      .addSelect('config.settings')
      .where('config.id = :id', { id: config.id })
      .getOneOrFail();
  const patch = (body: object) =>
    request(ctx.server).patch(endpoint).set('Cookie', cookie).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx.server);
    await ctx.dataSource
      .getRepository(User)
      .update(admin.userId, { role: Role.ADMIN });
    cookie = await signIn(ctx.server, admin.email, admin.password);
    member = await createUser(ctx.server);
    await ctx.app.get(SystemConfigsService).getConfig();
    config = await ctx.dataSource
      .getRepository(SystemConfig)
      .createQueryBuilder('config')
      .addSelect('config.settings')
      .getOneOrFail();
  });
  beforeEach(async () => {
    await ctx.dataSource
      .getRepository(SystemConfig)
      .update(config.id, { settings: {} });
  });
  afterAll(async () => {
    try {
      if (config)
        await ctx.dataSource
          .getRepository(SystemConfig)
          .update(config.id, { settings: config.settings });
      if (admin && member)
        await cleanupE2eData(ctx.dataSource, {
          userIds: [admin.userId, member.userId],
        });
    } finally {
      await closeTestApp(ctx?.app);
    }
  });

  it('returns defaults only to an authenticated admin', async () => {
    await request(ctx.server).get(endpoint).expect(401);
    await request(ctx.server)
      .get(endpoint)
      .set('Cookie', member.cookie)
      .expect(403);
    await request(ctx.server)
      .patch(endpoint)
      .set('Cookie', member.cookie)
      .send({ auth: { allowSignUp: true } })
      .expect(403);
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toMatchObject({
      auth: { allowSignUp: false },
      mailServer: {
        enabled: false,
        provider: 'smtp',
        port: 587,
        hasPassword: false,
      },
    });
    expect(res.body.mailServer).not.toHaveProperty('password');
  });
  it('encrypts passwords and preserves them on omitted or empty updates', async () => {
    await patch({
      mailServer: {
        host: 'smtp.example.com',
        fromEmail: 'argus@example.com',
        password,
      },
    }).expect(200);
    const stored = (await readStored()).settings.mailServer.password as string;
    expect(stored).toMatch(/^v2:/);
    expect(decrypt(stored)).toBe(password);
    await patch({ mailServer: { password: '', fromName: 'Argus' } }).expect(
      200,
    );
    await patch({ auth: { allowSignUp: true } }).expect(200);
    await patch({
      mailServer: { password: null, fromName: null },
      auth: null,
    }).expect(200);
    expect((await readStored()).settings.mailServer.password).toBe(stored);
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.mailServer).toMatchObject({
      fromName: 'Argus',
      hasPassword: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect(JSON.stringify(res.body)).not.toContain(stored);
  });
  it('merges concurrent fields and keeps unrelated stored sections', async () => {
    await ctx.dataSource
      .getRepository(SystemConfig)
      .update(config.id, { settings: { future: { value: 7 } } });
    await Promise.all([
      patch({ auth: { allowSignUp: true } }).expect(200),
      patch({ mailServer: { username: 'argus' } }).expect(200),
      patch({ mailServer: { fromName: 'Argus' } }).expect(200),
    ]);
    expect((await readStored()).settings).toMatchObject({
      future: { value: 7 },
      auth: { allowSignUp: true },
      mailServer: { username: 'argus', fromName: 'Argus' },
    });
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).not.toHaveProperty('future');
  });
  it('validates mail enablement against concurrent configuration edits', async () => {
    await patch({
      mailServer: { host: 'smtp.example.com', fromEmail: 'argus@example.com' },
    }).expect(200);
    const results = await Promise.all([
      patch({ mailServer: { enabled: true } }),
      patch({ mailServer: { host: '' } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const mail = (await readStored()).settings.mailServer;
    expect(mail.enabled !== true || !!mail.host).toBe(true);
  });
  it.each([
    { auth: { allowSignUp: 'yes' } },
    { mailServer: { port: 0 } },
    { mailServer: { port: 65536 } },
    { mailServer: { provider: 'unknown' } },
    { mailServer: { fromEmail: 'bad' } },
    { mailServer: { fromEmail: false } },
    { mailServer: [] },
  ])('rejects invalid settings %j', async (body) => {
    await patch(body).expect(400);
    expect((await readStored()).settings).toEqual({});
  });
  it('requires a host and sender to enable mail and ignores readonly and unknown input', async () => {
    await patch({ mailServer: { enabled: true, password } }).expect(400);
    expect((await readStored()).settings).toEqual({});
    await patch({
      mailServer: {
        enabled: true,
        host: 'smtp.example.com',
        fromEmail: 'argus@example.com',
        hasPassword: true,
      },
      unexpected: { enabled: true },
    }).expect(200);
    expect((await readStored()).settings).toEqual({
      mailServer: {
        enabled: true,
        host: 'smtp.example.com',
        fromEmail: 'argus@example.com',
      },
    });
  });
  it('keeps signup closed without mail and ordinary configuration responses private', async () => {
    await patch({
      auth: { allowSignUp: true },
      mailServer: {
        enabled: false,
        host: 'smtp.example.com',
        fromEmail: 'argus@example.com',
        password,
      },
    }).expect(200);
    const res = await request(ctx.server)
      .get('/api/admin/system-configs')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).not.toHaveProperty('settings');
    expect(
      (await request(ctx.server).get('/api/metadata').expect(200)).body,
    ).toHaveProperty('allowSignUp', false);
    await request(ctx.server)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Blocked',
        email: 'blocked-settings@example.com',
        password: 'Password123!',
      })
      .expect(403);
  });
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])(
    'publishes signup=%s and mail=%s as public eligibility=%s',
    async (allowSignUp, enabled, expected) => {
      await patch({
        auth: { allowSignUp },
        mailServer: {
          enabled,
          host: 'mailpit',
          fromEmail: 'argus@example.com',
          password,
        },
      }).expect(200);
      const { body } = await request(ctx.server)
        .get('/api/metadata')
        .expect(200);
      expect(body.allowSignUp).toBe(expected);
      for (const key of ['auth', 'mailServer', 'settings'])
        expect(body).not.toHaveProperty(key);
      expect(JSON.stringify(body)).not.toContain(password);
      expect(JSON.stringify(body)).not.toContain(
        (await readStored()).settings.mailServer.password,
      );
    },
  );

  it('refreshes public eligibility after saved settings change without restarting', async () => {
    const read = async () =>
      ((await request(ctx.server).get('/api/metadata').expect(200)).body as {
        allowSignUp: boolean;
      }).allowSignUp;
    expect(await read()).toBe(false);
    await patch({
      auth: { allowSignUp: true },
      mailServer: {
        enabled: true,
        host: 'mailpit',
        fromEmail: 'argus@example.com',
      },
    }).expect(200);
    expect(await read()).toBe(true);
    await patch({ mailServer: { enabled: false } }).expect(200);
    expect(await read()).toBe(false);
    await patch({
      mailServer: { enabled: true },
      auth: { allowSignUp: false },
    }).expect(200);
    expect(await read()).toBe(false);
  });

  it('retains encrypted settings during normal brand updates', async () => {
    const cipher = encrypt(password);
    await ctx.dataSource
      .getRepository(SystemConfig)
      .update(config.id, { settings: { mailServer: { password: cipher } } });
    await request(ctx.server)
      .put('/api/admin/system-configs')
      .set('Cookie', cookie)
      .send({ name: config.name })
      .expect(200);
    expect((await readStored()).settings.mailServer.password).toBe(cipher);
  });
  describe('test mail', () => {
    const path = endpoint + '/mail-server/test';
    afterEach(() => jest.restoreAllMocks());

    it('rejects unauthenticated and non-admin callers without delivery', async () => {
      const send = jest.spyOn(ctx.app.get(MailService), 'sendTest');
      await request(ctx.server)
        .post(path)
        .send({ to: 'recipient@example.com' })
        .expect(401);
      await request(ctx.server)
        .post(path)
        .set('Cookie', member.cookie)
        .send({ to: 'recipient@example.com' })
        .expect(403);
      expect(send).not.toHaveBeenCalled();
    });

    it.each([
      {},
      { to: null },
      { to: '' },
      { to: 'not-an-email' },
      { to: ['recipient@example.com'] },
      { to: 'a@example.com\r\nBcc: b@example.com' },
    ])('rejects invalid recipient %j before delivery', async (body) => {
      const send = jest.spyOn(ctx.app.get(MailService), 'sendTest');
      await request(ctx.server)
        .post(path)
        .set('Cookie', cookie)
        .send(body)
        .expect(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('returns 201 and ignores client-supplied message and SMTP overrides', async () => {
      const send = jest
        .spyOn(ctx.app.get(MailService), 'sendTest')
        .mockResolvedValue({ message: 'Test email sent' });
      const response = await request(ctx.server)
        .post(path)
        .set('Cookie', cookie)
        .send({
          to: 'recipient@example.com',
          subject: 'ignored',
          host: 'ignored',
          password: 'ignored',
        })
        .expect(201);
      expect(response.body).toEqual({ message: 'Test email sent' });
      expect(send).toHaveBeenCalledWith('recipient@example.com');
    });

    it('returns a safe 400 while saved mail is disabled', async () => {
      const response = await request(ctx.server)
        .post(path)
        .set('Cookie', cookie)
        .send({ to: 'recipient@example.com' })
        .expect(400);
      expect(response.body.message).toBe(
        'Test email failed. Check the mail server settings.',
      );
      expect((await readStored()).settings).toEqual({});
    });
  });
});
