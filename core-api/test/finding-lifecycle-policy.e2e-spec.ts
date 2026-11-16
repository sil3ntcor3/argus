import * as request from 'supertest';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding lifecycle policy API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let reader: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const path = '/api/vulnerabilities/settings';

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'lifecycle-policy');
    foreign = await createUserWithWorkspace(app.server, 'lifecycle-foreign');
    reader = await createUserWithWorkspace(app.server, 'lifecycle-reader');
    const [{ id: member }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1,$2) RETURNING id',
      [owner.workspace.id, reader.user.userId],
    );
    const [{ id: role }] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3) RETURNING id',
      [owner.workspace.id, randomUUID(), ['workspace.read', 'vulnerability.read']],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1,$2)',
      [member, role],
    );
  });

  beforeEach(async () => {
    await app.dataSource.query(
      `UPDATE workspaces SET settings = '{"retained":{"value":true}}'::jsonb WHERE id = $1`,
      [owner.workspace.id],
    );
  });

  afterAll(async () => {
    if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner, foreign, reader].filter(Boolean).map(value => value.workspace.id),
      userIds: [owner, foreign, reader].filter(Boolean).map(value => value.user.userId),
    });
    await closeTestApp(app?.app);
  });

  it('returns released defaults only to effective finding readers in the selected workspace', async () => {
    const response = await request(app.server).get(path).set(owner.headers).expect(200);
    expect(response.body).toEqual({
      slaDays: { critical: 7, high: 30, medium: 90, low: 120, info: null },
      slaRestartOnResurface: true, autoCloseEnabled: true,
      autoCloseMissedScans: 1, riskAcceptMaxDays: 180,
    });
    await request(app.server).get(path).expect(401);
    await request(app.server).get(path).set(foreign.headers)
      .set('X-Workspace-Id', owner.workspace.id).expect(403);
    await request(app.server).get(path).set(reader.headers)
      .set('X-Workspace-Id', owner.workspace.id).expect(200);
    await request(app.server).put(path).set(reader.headers)
      .set('X-Workspace-Id', owner.workspace.id).send({ autoCloseEnabled: false }).expect(403);
  });

  it('serializes partial saves and preserves other workspace settings', async () => {
    await Promise.all([
      request(app.server).put(path).set(owner.headers).send({ autoCloseEnabled: false }).expect(200),
      request(app.server).put(path).set(owner.headers).send({ riskAcceptMaxDays: 365 }).expect(200),
    ]);
    const response = await request(app.server).get(path).set(owner.headers).expect(200);
    expect(response.body).toMatchObject({ autoCloseEnabled: false, riskAcceptMaxDays: 365 });
    const [{ settings }] = await app.dataSource.query<{ settings: Record<string, unknown> }[]>(
      'SELECT settings FROM workspaces WHERE id = $1', [owner.workspace.id],
    );
    expect(settings.retained).toEqual({ value: true });
  });

  it('uses the saved risk window for new acceptances without revoking earlier decisions', async () => {
    const [{ id: target }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2) RETURNING id`,
      [`${randomUUID()}.example.test`, owner.workspace.id],
    );
    const [{ id: asset }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO assets (value,"targetId") VALUES ($1,$2) RETURNING id`, [randomUUID(), target],
    );
    const createFinding = async () => {
      const [{ id }] = await app.dataSource.query<{ id: string }[]>(
        `INSERT INTO vulnerabilities (name,severity,"assetId") VALUES ($1,'high',$2) RETURNING id`,
        [randomUUID(), asset],
      );
      return id;
    };
    const accept = (id: string, days: number) => request(app.server)
      .post('/api/vulnerabilities/dismiss').set(owner.headers).send({
        ids: [id], reason: 'risk_accepted',
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
    await request(app.server).put(path).set(owner.headers).send({ riskAcceptMaxDays: 365 }).expect(200);
    const accepted = await createFinding();
    await accept(accepted, 364).expect(201);
    await request(app.server).put(path).set(owner.headers).send({ riskAcceptMaxDays: 1 }).expect(200);
    await accept(await createFinding(), 2).expect(400);
    await accept(await createFinding(), 0.5).expect(201);
    const detail = await request(app.server).get(`/api/vulnerabilities/${accepted}`).set(owner.headers).expect(200);
    expect(detail.body.vulnerabilityDismissal.reason).toBe('risk_accepted');
    await request(app.server).put(path).set(owner.headers).send({ riskAcceptMaxDays: 3650 }).expect(200);
    await accept(await createFinding(), 3649).expect(201);
  });

  it.each([
    { autoCloseEnabled: 'false' }, { autoCloseEnabled: null },
    { autoCloseMissedScans: 0 }, { autoCloseMissedScans: 11 },
    { autoCloseMissedScans: 1.5 }, { riskAcceptMaxDays: 0 },
    { riskAcceptMaxDays: 3651 }, { slaDays: null },
    { slaDays: { high: 0 } }, { slaDays: { high: 3651 } },
    { slaDays: { high: '30' } }, { slaRestartOnResurface: null },
  ])('rejects invalid policy without saving it: %j', async body => {
    await request(app.server).put(path).set(owner.headers).send(body).expect(400);
    const [{ settings }] = await app.dataSource.query<{ settings: Record<string, unknown> }[]>(
      'SELECT settings FROM workspaces WHERE id = $1', [owner.workspace.id],
    );
    expect(settings).not.toHaveProperty('vulnerabilityManagement');
  });

  it('retains the latest resurface anchor after another positive makes the finding active', async () => {
    const [{ id: target }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2) RETURNING id`,
      [randomUUID() + '.example.test', owner.workspace.id]);
    const [{ id: asset }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO assets(value,"targetId") VALUES($1,$2) RETURNING id`, [randomUUID(), target]);
    const [{ id: finding }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO vulnerabilities(name,severity,"assetId","detectionStatus","firstDetectedDate")
       VALUES($1,'high',$2,'active','2026-01-01T00:00:00Z') RETURNING id`, [randomUUID(), asset]);
    await app.dataSource.query(`INSERT INTO vulnerability_events
      ("vulnerabilityId","workspaceId",type,"toStatus","occurredAt")
      VALUES($1,$2,'status_changed','resurfaced','2026-11-01T00:00:00Z')`, [finding, owner.workspace.id]);
    const deadline = async () => (await app.dataSource.query<{ dueAt: Date | null }[]>(
      'SELECT "dueAt" FROM vulnerabilities WHERE id=$1', [finding]))[0].dueAt;
    await request(app.server).put(path).set(owner.headers).send({ slaDays: { high: 14 } }).expect(200);
    expect(await deadline()).toEqual(new Date('2026-11-15T00:00:00Z'));
    await request(app.server).put(path).set(owner.headers).send({ slaRestartOnResurface: false }).expect(200);
    expect(await deadline()).toEqual(new Date('2026-01-15T00:00:00Z'));
    await request(app.server).put(path).set(owner.headers).send({ slaDays: { high: null } }).expect(200);
    expect(await deadline()).toBeNull();
  });
});
