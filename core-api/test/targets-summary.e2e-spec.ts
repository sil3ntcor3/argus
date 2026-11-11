import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target summary and filters API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let currentTarget: string;
  let staleTarget: string;
  let neverDiscoveredTarget: string;
  const path = '/api/targets/summary';
  const counts = { total: 3, scanning: 1, scheduled: 1, stale: 2 };
  const findings = { critical: 3, high: 1, medium: 0, low: 0, info: 0 };
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const get = (headers: Record<string, string>) =>
    request(app.server).get(path).set(headers);
  const list = (headers: Record<string, string>, query = '') =>
    request(app.server).get(`/api/targets${query}`).set(headers);

  function expectPage(ids: string[], total = ids.length) {
    return ({ body }: { body: { data: { id: string }[]; total: number } }) => {
      expect(body.data.map(({ id }) => id).sort()).toEqual([...ids].sort());
      expect(body.total).toBe(total);
    };
  }

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
    const asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      [value, target],
    );
    return { target, asset };
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
    const neverDiscovered = await targetAsset(workspace, null);
    const foreign = await targetAsset(other.workspace.id, null);
    currentTarget = current.target;
    staleTarget = stale.target;
    neverDiscoveredTarget = neverDiscovered.target;
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
      [current.asset, 'pending'],
      [current.asset, 'in_progress'],
      [stale.asset, 'completed'],
    ]) {
      await app.dataSource.query(
        'INSERT INTO jobs ("jobHistoryId","assetId","toolId",category,status) VALUES ($1,$2,$3,\'vulnerabilities\',$4)',
        [run, asset, tool, status],
      );
    }
    for (const [asset, severity, archived, dismissed] of [
      [current.asset, 'critical', false, false],
      [current.asset, 'critical', false, false],
      [stale.asset, 'high', false, false],
      [stale.asset, 'critical', false, false],
      [neverDiscovered.asset, 'critical', true, false],
      [neverDiscovered.asset, 'critical', false, true],
      [foreign.asset, 'critical', false, false],
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
      withCritical: 2,
      openVulnerabilities: findings,
    });
    expect(result.headers['cache-control']).toContain('no-store');
    const foreign = await get(other.headers).expect(200);
    expect(foreign.body).toEqual({
      total: 1,
      scanning: 0,
      scheduled: 0,
      stale: 1,
      withCritical: 1,
      openVulnerabilities: { ...findings, critical: 1, high: 0 },
    });
  });

  it('filters open critical and stale targets separately or together within the workspace', async () => {
    await list(owner.headers, '?hasCritical=true')
      .expect(200)
      .expect(expectPage([currentTarget, staleTarget]));
    await list(owner.headers, '?stale=true')
      .expect(200)
      .expect(expectPage([staleTarget, neverDiscoveredTarget]));
    await list(owner.headers, '?hasCritical=true&stale=true')
      .expect(200)
      .expect(expectPage([staleTarget]));
    await list(owner.headers, '?hasCritical=false&stale=false')
      .expect(200)
      .expect(expectPage([currentTarget, staleTarget, neverDiscoveredTarget]));
  });

  it('counts matching targets before pagination even with a scan status filter', async () => {
    const query = '?hasCritical=true&status=completed&limit=1';
    await list(owner.headers, query)
      .expect(200)
      .expect(expectPage([staleTarget]));
    await list(owner.headers, `${query}&page=2`)
      .expect(200)
      .expect(expectPage([], 1));
  });

  it.each(['hasCritical=1', 'stale=', 'stale=true&stale=false'])(
    'rejects a malformed or repeated boolean parameter (%s)',
    async (query) => {
      await list(owner.headers, `?${query}`).expect(400);
    },
  );

  it('requires target access and redacts findings until vulnerability access is granted', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await get({}).expect(401);
    await get(headers).expect(403);
    await list(headers, '?hasCritical=true').expect(403);
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [workspace, other.user.userId],
    );
    const role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), ['vulnerability.read'], workspace],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
    await get(headers).expect(403);
    await list(headers, '?hasCritical=true').expect(403);
    for (const extra of [[], ['vulnerability.read'], ['vulnerability.write']]) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [['target.read', ...extra], role],
      );
      const response = await get(headers).expect(200);
      expect(response.body).toEqual({
        ...counts,
        withCritical: extra.length ? 2 : null,
        openVulnerabilities: extra.length ? findings : null,
      });
      await list(headers, '?hasCritical=false&stale=true')
        .expect(200)
        .expect(expectPage([staleTarget, neverDiscoveredTarget]));
      const critical = await list(headers, '?hasCritical=true').expect(
        extra.length ? 200 : 403,
      );
      expect(critical.headers['cache-control']).toContain('no-store');
      if (extra.length) expectPage([currentTarget, staleTarget])(critical);
    }
  });
});
