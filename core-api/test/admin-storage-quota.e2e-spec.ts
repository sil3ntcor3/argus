import { Role, AuditOutcome } from '@/common/enums/enum';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { signIn } from './helpers/auth';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

describe('Platform-admin workspace quota API (e2e)', () => {
  let app: TestApp;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const foreignWorkspace = randomUUID();
  const update = (quotaBytes: unknown, id = owner.workspace.id) => request(app.server)
    .patch(`/api/admin/workspaces/${id}/storage-quota`).set('Cookie', admin.cookie)
    .set('X-Workspace-Id', foreignWorkspace).send({ quotaBytes });
  const meter = () => app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId: owner.workspace.id });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'quota-owner');
    admin = await createUser(app.server, { name: 'Quota admin' });
    await app.dataSource.query('UPDATE users SET role=$1 WHERE id=$2', [Role.ADMIN, admin.userId]);
    admin.cookie = await signIn(app.server, admin.email, admin.password);
    await app.dataSource.query('INSERT INTO workspaces(id,name) VALUES ($1,$2)', [foreignWorkspace, 'Quota audit isolation']);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, foreignWorkspace].filter(Boolean),
        userIds: [owner?.user.userId, admin?.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('requires a platform admin and rejects invalid bodies and absent workspaces without writing', async () => {
    const path = `/api/admin/workspaces/${owner.workspace.id}/storage-quota`;
    await request(app.server).patch(path).send({ quotaBytes: 1 }).expect(401);
    await request(app.server).patch(path).set(owner.headers).send({ quotaBytes: 1 }).expect(403);
    for (const value of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', true, [], {}]) {
      await update(value).expect(400);
    }
    await update(1, 'invalid').expect(400);
    await update(1, randomUUID()).expect(404);
    expect(await meter()).toBeNull();
  });

  it('preserves balances across zero, maximum, and default overrides and settles existing reservations', async () => {
    await app.dataSource.getRepository(WorkspaceStorageUsage).insert({
      workspaceId: owner.workspace.id, usedBytes: '7', reservedBytes: '3',
    });
    await update(0).expect(200, { workspaceId: owner.workspace.id, quotaBytes: 0 });
    expect(await meter()).toMatchObject({ quotaBytes: '0', usedBytes: '7', reservedBytes: '3' });
    const quota = app.app.get(ArtifactQuotaService);
    await app.dataSource.transaction(async manager => {
      expect(await quota.reserve(manager, owner.workspace.id, 1)).toBe(false);
      expect(await quota.commit(manager, owner.workspace.id, 3)).toBe(true);
    });
    await update(Number.MAX_SAFE_INTEGER).expect(200, { workspaceId: owner.workspace.id, quotaBytes: Number.MAX_SAFE_INTEGER });
    expect(await meter()).toMatchObject({ quotaBytes: String(Number.MAX_SAFE_INTEGER), usedBytes: '10', reservedBytes: '0' });
    await update(null).expect(200, { workspaceId: owner.workspace.id, quotaBytes: null });
    await update(null).expect(200, { workspaceId: owner.workspace.id, quotaBytes: null });
    expect(await meter()).toMatchObject({ quotaBytes: null, usedBytes: '10', reservedBytes: '0' });
    const usage = await request(app.server).get('/api/artifacts/usage').set(owner.headers).expect(200);
    expect(usage.body).toMatchObject({ quotaBytes: 1073741824, usedBytes: 10, reservedBytes: 0 });
  });

  it('persists saved quota values in the target workspace audit trail with admin attribution', async () => {
    let events: AuditEvent[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      events = await app.dataSource.getRepository(AuditEvent).find({
        where: { workspaceId: owner.workspace.id, action: 'storage.quota.updated' },
      });
      if (events.length >= 4) break;
      await setTimeout(100);
    }
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event).toMatchObject({
        actorId: admin.userId, resourceType: 'storage', resourceId: owner.workspace.id,
        workspaceId: owner.workspace.id, outcome: AuditOutcome.Success, metadata: { platformAdmin: true },
      });
    }
    expect(events.map(event => event.changes.quotaBytes.after)).toEqual(expect.arrayContaining([0, Number.MAX_SAFE_INTEGER, null]));
    expect(await app.dataSource.getRepository(AuditEvent).countBy({ workspaceId: foreignWorkspace, action: 'storage.quota.updated' })).toBe(0);
    const filtered = await request(app.server).get(`/api/workspaces/${owner.workspace.id}/audit`)
      .set(owner.headers).query({ action: 'storage.quota.updated' }).expect(200);
    expect(filtered.body.data).toHaveLength(4);
  });
});
