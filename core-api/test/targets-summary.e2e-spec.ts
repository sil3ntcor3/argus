import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target summary API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let role: string;
  const path = '/api/targets/summary';
  const counts = { total: 3, scanning: 1, scheduled: 1, stale: 2 };
  const findings = { critical: 2, high: 1, medium: 0, low: 0, info: 0 };
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const get = (headers: Record<string, string>) =>
    request(app.server).get(path).set(headers);

  async function targetAsset(
    workspaceId: string,
    discovered: Date | null,
    schedule?: string,
  ) {
    const value = randomUUID() + '.example.test';
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId","lastDiscoveredAt","scanSchedule") VALUES ($1,\'DOMAIN\',$2,$3,$4)',
      [value, workspaceId, discovered, schedule ?? 'disabled'],
    );
    return insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
      value,
      target,
    ]);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'target-summary-owner');
    other = await createUserWithWorkspace(app.server, 'target-summary-other');
    const workspace = owner.workspace.id;
    const current = await targetAsset(workspace, new Date(), '0 0 * * *');
    const stale = await targetAsset(
      workspace,
      new Date(Date.now() - 31 * 86400_000),
    );
    await targetAsset(workspace, null);
    const foreign = await targetAsset(other.workspace.id, new Date());
    const [{ id: tool }] = await app.dataSource.query<{ id: string }[]>(
      "SELECT id FROM tools WHERE name='nuclei' LIMIT 1",
    );
    const [{ id: workflow }] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId"=$1 LIMIT 1',
      [workspace],
    );
    const run = await insert(
      'INSERT INTO job_histories ("workflowId") VALUES ($1)',
      [workflow],
    );
    for (const [asset, status] of [
      [current, 'pending'],
      [current, 'in_progress'],
      [stale, 'completed'],
    ]) {
      await app.dataSource.query(
        'INSERT INTO jobs ("jobHistoryId","assetId","toolId",category,status) VALUES ($1,$2,$3,\'vulnerabilities\',$4)',
        [run, asset, tool, status],
      );
    }
    for (const [asset, severity, archived, dismissed] of [
      [current, 'critical', false, false],
      [current, 'critical', false, false],
      [stale, 'high', false, false],
      [stale, 'critical', true, false],
      [stale, 'critical', false, true],
      [foreign, 'critical', false, false],
    ] as const) {
      const id = await insert(
        'INSERT INTO vulnerabilities (name,severity,"assetId","isArchived") VALUES ($1,$2,$3,$4)',
        [randomUUID(), severity, asset, archived],
      );
      if (dismissed)
        await app.dataSource.query(
          'INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason) VALUES ($1,$2,$3)',
          [id, owner.user.userId, 'Fixture dismissal'],
        );
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
          Boolean,
        ),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('counts targets once and returns only open findings in the selected workspace', async () => {
    const result = await get(owner.headers).expect(200);
    expect(result.body).toEqual({
      ...counts,
      withCritical: 1,
      openVulnerabilities: findings,
    });
    expect(result.headers['cache-control']).toContain('no-store');
    const foreign = await get(other.headers).expect(200);
    expect(foreign.body).toEqual({
      total: 1,
      scanning: 0,
      scheduled: 0,
      stale: 0,
      withCritical: 1,
      openVulnerabilities: { ...findings, critical: 1, high: 0 },
    });
  });

  it('requires target access and redacts findings until vulnerability access is granted', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await get({}).expect(401);
    await get(headers).expect(403);
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [workspace, other.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), ['vulnerability.read'], workspace],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
    await get(headers).expect(403);
    for (const extra of [[], ['vulnerability.read'], ['vulnerability.write']]) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [['target.read', ...extra], role],
      );
      const response = await get(headers).expect(200);
      expect(response.body).toEqual({
        ...counts,
        withCritical: extra.length ? 1 : null,
        openVulnerabilities: extra.length ? findings : null,
      });
    }
  });
});
