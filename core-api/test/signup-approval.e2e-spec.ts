import { PENDING_APPROVAL_REASON } from '@/common/constants/app.constants';
import {
  MailService,
  type MailMessage,
} from '@/modules/admin/system-configs/mail.service';
import { SystemConfigsService } from '@/modules/admin/system-configs/system-configs.service';
import { User } from '@/modules/auth/entities/user.entity';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { signIn } from './helpers/auth';
import { createUser, cleanupE2eData } from './helpers/workspace';

describe('Public signup and approval', () => {
  let app: TestApp;
  let server: App;
  let db: DataSource;
  let settings: SystemConfigsService;
  let adminCookie: string;
  let memberCookie: string;
  let original: Awaited<ReturnType<SystemConfigsService['getSettingsView']>>;
  const userIds: string[] = [];
  const sent: MailMessage[] = [];
  const password = 'Password123!';
  let send: jest.SpyInstance;
  const email = () => 'e2e-signup-' + randomUUID() + '@example.com';
  const signup = (address: string, extra = {}) =>
    request(server)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Argus newcomer',
        email: address,
        password,
        callbackURL: 'http://console.e2e.test/login',
        ...extra,
      });
  const approve = (userId: string, cookie = adminCookie) =>
    request(server)
      .post('/api/auth/admin/unban-user')
      .set('Cookie', cookie)
      .send({ userId });
  const user = async (address: string) => {
    const row = await db
      .getRepository(User)
      .findOneByOrFail({ email: address });
    userIds.push(row.id);
    return row;
  };
  const link = () =>
    new URL(/https?:\/\/\S+/.exec(sent.at(-1)?.text ?? '')?.[0] ?? '');

  beforeAll(async () => {
    app = await createTestApp();
    server = app.server;
    db = app.dataSource;
    settings = app.app.get(SystemConfigsService);
    original = await settings.getSettingsView();
    const admin = await createUser(server, { name: 'Approver' });
    const member = await createUser(server, { name: 'Member' });
    userIds.push(admin.userId, member.userId);
    await db
      .getRepository(User)
      .update(admin.userId, { role: 'admin' as User['role'] });
    adminCookie = await signIn(server, admin.email, admin.password);
    memberCookie = member.cookie;
    send = jest
      .spyOn(app.app.get(MailService), 'send')
      .mockImplementation((message: MailMessage) => {
        sent.push(message);
        return Promise.resolve();
      });
  });
  beforeEach(async () => {
    sent.length = 0;
    await settings.updateSettings({
      auth: { allowSignUp: true },
      mailServer: {
        enabled: true,
        host: 'smtp.e2e.test',
        fromEmail: 'argus@example.com',
      },
    });
  });
  afterAll(async () => {
    send?.mockRestore();
    if (settings && original) await settings.updateSettings(original);
    if (db) await cleanupE2eData(db, { userIds });
    if (app) await closeTestApp(app.app);
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])(
    'closes signup with allowSignUp=%s and mail=%s',
    async (allowSignUp, enabled) => {
      await settings.updateSettings({
        auth: { allowSignUp },
        mailServer: { enabled },
      });
      const address = email();
      const res = await signup(address).expect(403);
      expect(res.body.message).toBe('Sign-up is disabled');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(
        await db.getRepository(User).findOneBy({ email: address }),
      ).toBeNull();
      expect(sent).toHaveLength(0);
    },
  );

  it('requires verification then approval, retaining the correct-password boundary', async () => {
    const address = email();
    const res = await signup(address).expect(200);
    const row = await user(address);
    expect(res.body.token).toBeNull();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(row).toMatchObject({
      banned: true,
      banReason: PENDING_APPROVAL_REASON,
      emailVerified: false,
      role: 'user',
    });
    expect(sent).toHaveLength(1);
    const verify = link();
    const claims = JSON.parse(
      Buffer.from(
        verify.searchParams.get('token')!.split('.')[1],
        'base64url',
      ).toString(),
    ) as { exp: number; iat: number };
    expect(claims.exp - claims.iat).toBe(86400);
    await approve(row.id)
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('EMAIL_NOT_VERIFIED'));
    await approve(row.id, memberCookie)
      .expect(403)
      .expect(({ body }) => expect(body.code).not.toBe('EMAIL_NOT_VERIFIED'));
    await approve(row.id, '').expect(401);
    await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: address, password: 'WrongPassword!' })
      .expect(401)
      .expect(({ body }) =>
        expect(body.code).toBe('INVALID_EMAIL_OR_PASSWORD'),
      );
    await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: address, password })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('EMAIL_NOT_VERIFIED'));
    await request(server)
      .get(verify.pathname + verify.search)
      .expect(302)
      .expect(({ headers }) => {
        expect(headers.location).toBe('http://console.e2e.test/login');
        expect(headers['set-cookie']).toBeUndefined();
      });
    await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: address, password })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('BANNED_USER'));
    await approve(row.id).expect(200);
    expect(await signIn(server, address, password)).toContain('session=');
  });

  it('rejects coerced user IDs instead of bypassing verification', async () => {
    const address = email();
    await signup(address).expect(200);
    const row = await user(address);
    await request(server)
      .post('/api/auth/admin/unban-user')
      .set('Cookie', adminCookie)
      .send({ userId: [row.id] })
      .expect(400);
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: row.id })).banned,
    ).toBe(true);
  });

  it('rejects caller-supplied privilege and verification fields', async () => {
    const address = email();
    await signup(address, {
      role: 'admin',
      banned: false,
      emailVerified: true,
    }).expect(400);
    expect(
      await db.getRepository(User).findOneBy({ email: address }),
    ).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('keeps duplicate signup indistinguishable and cannot overwrite the account', async () => {
    const address = email();
    const created = await signup(address).expect(200);
    const row = await user(address);
    const duplicate = await signup(address, {
      name: 'Overwritten',
      password: 'DifferentPassword!',
    }).expect(200);
    expect(duplicate.body.token).toBeNull();
    const publicFields = [
      'role',
      'banned',
      'banReason',
      'banExpires',
      'emailVerified',
      'image',
    ];
    for (const field of publicFields)
      expect(duplicate.body.user[field]).toEqual(created.body.user[field]);
    expect(Object.keys(duplicate.body.user).sort()).toEqual(
      Object.keys(created.body.user).sort(),
    );

    expect(duplicate.headers['set-cookie']).toBeUndefined();
    expect(
      await db.getRepository(User).findOneByOrFail({ id: row.id }),
    ).toMatchObject({
      name: 'Argus newcomer',
      banned: true,
      emailVerified: false,
    });
    await db
      .getRepository(User)
      .update(row.id, {
        emailVerified: true,
        banned: false,
        role: 'admin' as User['role'],
      });
    const approvedDuplicate = await signup(address).expect(200);
    for (const field of publicFields)
      expect(approvedDuplicate.body.user[field]).toEqual(
        created.body.user[field],
      );

  });

  it('rejects tampered links and can resend without disclosing unknown accounts', async () => {
    const address = email();
    await signup(address).expect(200);
    const row = await user(address);
    const verify = link();
    verify.searchParams.set('token', 'invalid-token');
    await request(server)
      .get(verify.pathname + verify.search)
      .expect(302)
      .expect(({ headers }) => expect(headers.location).toContain('error='));
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: row.id }))
        .emailVerified,
    ).toBe(false);
    const resend = (email: string) =>
      request(server)
        .post('/api/auth/send-verification-email')
        .send({ email, callbackURL: 'http://console.e2e.test/login' });
    const unknown = await resend(email()).expect(200);
    const known = await resend(address).expect(200);
    expect(known.body).toEqual(unknown.body);
    expect(sent).toHaveLength(2);
    const resent = link();
    await request(server)
      .get(resent.pathname + resent.search)
      .expect(302);
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: row.id }))
        .emailVerified,
    ).toBe(true);
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: row.id })).banned,
    ).toBe(true);
  });

  it('retains the account after SMTP failure so resend can recover it', async () => {
    send.mockRejectedValueOnce(new Error('synthetic SMTP refusal'));
    const address = email();
    await signup(address).expect(200);
    expect(await user(address)).toMatchObject({
      banned: true,
      emailVerified: false,
    });
    await request(server)
      .post('/api/auth/send-verification-email')
      .send({ email: address })
      .expect(200);
    expect(sent).toHaveLength(1);
  });

  it('lets an administrator approve when mail is disabled without changing ordinary bans', async () => {
    const address = email();
    await signup(address).expect(200);
    const row = await user(address);
    await settings.updateSettings({ mailServer: { enabled: false } });
    await approve(row.id).expect(200);
    expect(await signIn(server, address, password)).toContain('session=');
    await request(server)
      .post('/api/auth/admin/ban-user')
      .set('Cookie', adminCookie)
      .send({ userId: row.id, banReason: 'Ordinary ban' })
      .expect(200);
    await settings.updateSettings({ mailServer: { enabled: true } });
    await approve(row.id).expect(200);
  });
});
