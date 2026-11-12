import { Role } from '@/common/enums/enum';
import { AdminService } from '@/modules/admin/admin.service';
import { SystemConfig } from '@/modules/admin/system-configs/entities/system-config.entity';
import { SystemConfigsService } from '@/modules/admin/system-configs/system-configs.service';
import { User } from '@/modules/auth/entities/user.entity';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { signIn } from './helpers/auth';
import { cleanupE2eData, createUser, type TestUser } from './helpers/workspace';

describe('Admin IP allow-list (e2e)', () => {
  let ctx: TestApp, admin: TestUser, member: TestUser, cookie: string;
  let original: SystemConfig;
  const previousProxies = process.env.TRUSTED_PROXIES;
  const endpoint = '/api/admin/system-configs/settings';
  const local = ['127.0.0.1/32', '::1/128'];
  const configRepo = () => ctx.dataSource.getRepository(SystemConfig);
  const policy = (allowedIps: unknown) =>
    configRepo().update(original.id, {
      settings: { adminAccess: { allowedIps } },
    });
  const patch = (data: object) =>
    request(ctx.server).patch(endpoint).set('Cookie', cookie).send(data);

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await createUser(ctx.server);
    await ctx.dataSource
      .getRepository(User)
      .update(admin.userId, { role: Role.ADMIN });
    cookie = await signIn(ctx.server, admin.email, admin.password);
    member = await createUser(ctx.server);
    await ctx.app.get(SystemConfigsService).getConfig();
    original = await configRepo()
      .createQueryBuilder('c')
      .addSelect('c.settings')
      .getOneOrFail();
  });
  beforeEach(async () => {
    process.env.TRUSTED_PROXIES = '';
    await configRepo().update(original.id, { settings: {} });
  });
  afterAll(async () => {
    if (previousProxies === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = previousProxies;
    try {
      if (original)
        await configRepo().update(original.id, { settings: original.settings });
      if (admin && member)
        await cleanupE2eData(ctx.dataSource, {
          userIds: [admin.userId, member.userId],
        });
    } finally {
      await closeTestApp(ctx?.app);
    }
  });

  it('defaults to unrestricted without exposing unrelated private settings', async () => {
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.adminAccess).toEqual({ allowedIps: [] });
    expect(res.body.mailServer).not.toHaveProperty('password');
    await request(ctx.server).get(endpoint).expect(401);
    await request(ctx.server)
      .get(endpoint)
      .set('Cookie', member.cookie)
      .expect(403);
  });

  it('initializes one canonical row under concurrent configuration reads', async () => {
    const removeAll = () =>
      configRepo().createQueryBuilder().delete().execute();
    try {
      await removeAll();
      const service = ctx.app.get(SystemConfigsService);
      await Promise.all(Array.from({ length: 12 }, () => service.getConfig()));
      expect(await configRepo().count()).toBe(1);
      await patch({ adminAccess: { allowedIps: local } }).expect(200);
      const [row] = await configRepo()
        .createQueryBuilder('c')
        .addSelect('c.settings')
        .getMany();
      expect(row.settings.adminAccess.allowedIps).toEqual(local);
      expect(await service.isAdminIpAllowed('203.0.113.7')).toBe(false);
    } finally {
      await removeAll();
      await configRepo().save(original);
    }
  });

  it.each([false, true])(
    'keeps policy reads/writes canonical with duplicate rows (equal times=%s)',
    async (sameTime) => {
      const duplicate = await configRepo().save(
        configRepo().create({
          id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
          name: 'Unrestricted duplicate',
          settings: {},
          createdAt: new Date(
            original.createdAt.getTime() + (sameTime ? 0 : 60_000),
          ),
        }),
      );
      try {
        await configRepo().delete(original.id);
        await configRepo().save({
          ...original,
          settings: { adminAccess: { allowedIps: ['203.0.113.7'] } },
        });
        await request(ctx.server)
          .get(endpoint)
          .set('Cookie', cookie)
          .expect(403);
        await policy(local);
        await patch({
          adminAccess: { allowedIps: [...local, '203.0.113.7'] },
        }).expect(200);
        const rows = await configRepo()
          .createQueryBuilder('c')
          .addSelect('c.settings')
          .getMany();
        expect(
          rows.find((row) => row.id === original.id)?.settings.adminAccess
            .allowedIps,
        ).toEqual([...local, '203.0.113.7']);
        expect(rows.find((row) => row.id === duplicate.id)?.settings).toEqual(
          {},
        );
      } finally {
        await configRepo().delete(duplicate.id);
      }
    },
  );

  it.each([
    '/api/admin/system-configs/settings',
    '/api/admin/users',
    '/api/admin/workspaces',
  ])('enforces fresh policy on %s', async (path) => {
    await policy(['203.0.113.7']);
    await request(ctx.server).get(path).set('Cookie', cookie).expect(403);
    await policy(local);
    await request(ctx.server).get(path).set('Cookie', cookie).expect(200);
  });

  it('protects tool creation while keeping first-admin initialization public and locked', async () => {
    await policy(['203.0.113.7']);
    await request(ctx.server)
      .post('/api/admin/tools')
      .set('Cookie', cookie)
      .send({})
      .expect(403);
    const bootstrap = jest.spyOn(ctx.app.get(AdminService), 'createFirstAdmin');
    try {
      await request(ctx.server)
        .post('/api/admin/init')
        .send({
          email: 'blocked-bootstrap@example.test',
          password: 'ArgusBootstrap123!',
        })
        .expect(403);
      expect(bootstrap).toHaveBeenCalled();
    } finally {
      bootstrap.mockRestore();
    }
  });

  it('rejects self-lockout and malformed input, retaining the saved policy', async () => {
    await patch({ adminAccess: { allowedIps: ['203.0.113.7'] } }).expect(400);
    for (const allowedIps of [
      ['127.0.0.1/32/1'],
      [7],
      '127.0.0.1',
      Array(101).fill('127.0.0.1'),
    ]) {
      await patch({ adminAccess: { allowedIps } }).expect(400);
    }
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.adminAccess.allowedIps).toEqual([]);
  });

  it('normalizes, preserves omitted fields and merges concurrent settings patches', async () => {
    await Promise.all([
      patch({
        adminAccess: { allowedIps: [' 127.0.0.1/32 ', ...local] },
      }).expect(200),
      patch({ auth: { allowSignUp: false } }).expect(200),
    ]);
    await patch({ adminAccess: { allowedIps: null } }).expect(200);
    const res = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.adminAccess.allowedIps).toEqual(local);
    expect(res.body.auth.allowSignUp).toBe(false);
    await patch({ adminAccess: { allowedIps: [] } }).expect(200);
    const cleared = await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .expect(200);
    expect(cleared.body.adminAccess.allowedIps).toEqual([]);
  });

  it('ignores forged forwarding and only walks explicitly valid trusted proxies', async () => {
    await policy(['203.0.113.7']);
    const get = () =>
      request(ctx.server)
        .get(endpoint)
        .set('Cookie', cookie)
        .set('X-Forwarded-For', '1.1.1.1, 203.0.113.7');
    await get().expect(403);
    process.env.TRUSTED_PROXIES = '127.0.0.0/8/1,::1/128/1';
    await get().expect(403);
    process.env.TRUSTED_PROXIES = '127.0.0.0/8,::1/128';
    await get().expect(200);
    await request(ctx.server)
      .get(endpoint)
      .set('Cookie', cookie)
      .set('X-Forwarded-For', '203.0.113.7, 198.51.100.8')
      .expect(403);
  });

  it.each([null, false, '127.0.0.1', [7], ['127.0.0.1/32/1']])(
    'fails closed for malformed stored list %j',
    async (bad) => {
      await policy(bad);
      await request(ctx.server).get(endpoint).set('Cookie', cookie).expect(403);
    },
  );
});
