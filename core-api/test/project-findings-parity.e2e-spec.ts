import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import {
  cleanupE2eData,
  createUser,
  createUserWithWorkspace,
} from './helpers/workspace';

describe('Project findings release parity (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let reader: Awaited<ReturnType<typeof createUser>>, roleId: string;
  let project: string, assetId: string, foreignAsset: string;
  const sql = (text: string, args: unknown[] = []) =>
    app.dataSource.query(text, args);
  const insert = async (table: string, data: Record<string, unknown>) => {
    const keys = Object.keys(data);
    return (
      await app.dataSource.query<{ id: string }[]>(
        `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')})
      VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        Object.values(data),
      )
    )[0].id;
  };
  const path = () => `/api/projects/${project}/vulnerabilities`;
  const headers = () => ({
    Cookie: reader.cookie,
    'X-Workspace-Id': owner.workspace.id,
  });
  async function list(query = {}, h = owner.headers) {
    const response = await request(app.server)
      .get(path())
      .set(h)
      .query({ limit: 100, ...query })
      .expect(200);
    return response.body as {
      data: Record<string, unknown>[];
      total: number;
      severityCounts: Record<string, number>;
      provenanceCounts: { all: number };
    };
  }
  async function stats(h = owner.headers) {
    const response = await request(app.server)
      .get(path() + '/statistics')
      .set(h)
      .expect(200);
    return response.body as {
      data: { severity: string; count: number }[];
      pendingReview: number | null;
      byDetectionStatus: Record<string, number>;
      overdue: number;
      newLast7Days: number;
      resurfacedLast30Days: number;
      fixedLast30Days: number;
      mttr: { severity: string; count: number; days: number | null }[];
    };
  }
  async function finding(
    name: string,
    extra: Record<string, unknown> = {},
    linked = true,
  ) {
    const id = await insert('vulnerabilities', {
      name,
      fingerprint: randomUUID(),
      assetId,
      severity: 'high',
      firstDetectedDate: new Date('2020-01-01T12:00:00Z'),
      ...extra,
    });
    if (linked)
      await insert('project_vulnerabilities', {
        projectId: project,
        vulnerabilityId: id,
      });
    return id;
  }
  async function dismiss(
    id: string,
    reason = 'wont_fix',
    expiresAt: Date | null = null,
  ) {
    return insert('vulnerability_dismissals', {
      vulnerabilityId: id,
      userId: owner.user.userId,
      reason,
      expiresAt,
      comment: 'private dismissal comment',
    });
  }
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'project-parity');
    other = await createUserWithWorkspace(app.server, 'project-parity-other');
    reader = await createUser(app.server, {
      name: 'Project-only parity reader',
    });
    const member = await insert('workspace_members', {
      workspaceId: owner.workspace.id,
      userId: reader.userId,
    });
    roleId = await insert('workspace_permissions', {
      name: 'Project reader',
      workspaceId: owner.workspace.id,
      permissions: ['project.read'],
    });
    await insert('workspace_member_permissions', {
      memberId: member,
      permissionId: roleId,
    });
  });
  beforeEach(async () => {
    await sql('DELETE FROM projects WHERE "workspaceId"=ANY($1::uuid[])', [
      [owner.workspace.id, other.workspace.id],
    ]);
    await sql('DELETE FROM targets WHERE "workspaceId"=ANY($1::uuid[])', [
      [owner.workspace.id, other.workspace.id],
    ]);
    await sql('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
      ['project.read'],
      roleId,
    ]);
    project = await insert('projects', {
      name: 'Argus findings parity',
      workspaceId: owner.workspace.id,
    });
    const makeAsset = async (workspaceId: string) => {
      const value = randomUUID() + '.example.test';
      const targetId = await insert('targets', {
        value,
        type: 'DOMAIN',
        workspaceId,
      });
      return insert('assets', { value, targetId });
    };
    assetId = await makeAsset(owner.workspace.id);
    foreignAsset = await makeAsset(other.workspace.id);
  });
  afterAll(async () => {
    try {
      if (app)
        await cleanupE2eData(app.dataSource, {
          workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
            Boolean,
          ),
          userIds: [
            owner?.user.userId,
            other?.user.userId,
            reader?.userId,
          ].filter(Boolean),
        });
    } finally {
      await closeTestApp(app?.app);
    }
  });

  it('projects only approved lifecycle/action context and active dismissal references', async () => {
    const open = await finding('Open');
    const active = await finding('Accepted');
    const expired = await finding('Expired');
    const dismissalId = await dismiss(
      active,
      'risk_accepted',
      new Date(Date.now() + 86400000),
    );
    await dismiss(expired, 'risk_accepted', new Date(Date.now() - 86400000));
    const result = await list({ status: 'all' });
    const row = result.data.find((row) => row.id === open)!;
    expect(row).toMatchObject({
      reviewStatus: 'approved',
      detectionStatus: 'new',
      discoveredBy: 'tool',
      isArchived: false,
      dueAt: null,
      fixClaimedAt: null,
      lastSeenDate: null,
      vulnerabilityDismissal: null,
    });
    expect(
      result.data.find((row) => row.id === active)?.vulnerabilityDismissal,
    ).toEqual({
      id: dismissalId,
      reason: 'risk_accepted',
      expiresAt: expect.any(String),
    });
    expect(
      result.data.find((row) => row.id === expired)?.vulnerabilityDismissal,
    ).toBeNull();
    for (const key of [
      'proof',
      'sources',
      'scanScopeKey',
      'lastScannerObservedAt',
      'fixClaimedById',
      'metadata',
      'missedScans',
    ])
      expect(row).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain('private dismissal comment');
  });

  it('combines source, overdue and tree filters while facets ignore only their own dimension', async () => {
    const deadline = new Date(Date.now() - 3600000);
    const id = await finding('TLS 100%_ match', {
      discoveredBy: 'ai',
      dueAt: deadline,
      tags: ['tls'],
      cvssScore: '9.1',
    });
    await finding('TLS critical', {
      discoveredBy: 'ai',
      dueAt: deadline,
      severity: 'critical',
      tags: ['tls'],
    });
    await finding('TLS scanner', { dueAt: deadline, tags: ['tls'] });
    await finding('TLS future', {
      discoveredBy: 'ai',
      dueAt: new Date(Date.now() + 86400000),
      tags: ['tls'],
    });
    const filter = JSON.stringify({
      logic: 'and',
      items: [{ field: 'tag', op: 'eq', value: 'tls' }],
    });
    const result = await list({
      discoveredBy: ['ai'],
      overdue: true,
      severity: ['high'],
      filter,
    });
    expect(result.data.map((row) => row.id)).toEqual([id]);
    expect(result.severityCounts).toMatchObject({ high: 1, critical: 1 });
    expect(result.provenanceCounts.all).toBe(1);
    expect(
      (
        await list({
          filter: JSON.stringify({
            logic: 'and',
            items: [{ field: 'name', op: 'contains', value: "' OR true --" }],
          }),
        })
      ).total,
    ).toBe(0);
    expect(
      (await list({ overdue: true, search: '100%_' })).data.map(
        (row) => row.id,
      ),
    ).toEqual([id]);
  });

  it('filters first detection with the legacy fallback and full UTC upper day', async () => {
    const detected = await finding('Detected', {
      firstDetectedDate: new Date('2020-01-31T23:59:59Z'),
    });
    const legacy = await finding('Legacy', {
      firstDetectedDate: null,
      createdAt: new Date('2020-01-31T12:00:00Z'),
    });
    await finding('Old detection', {
      createdAt: new Date('2020-01-31T12:00:00Z'),
      firstDetectedDate: new Date('2019-01-01T00:00:00Z'),
    });
    await finding('Next day', {
      firstDetectedDate: new Date('2020-02-01T00:00:00Z'),
    });
    const result = await list({
      createdFrom: '2020-01-31',
      createdTo: '2020-01-31',
    });
    expect(result.data.map((row) => row.id).sort()).toEqual(
      [detected, legacy].sort(),
    );
  });

  it('sorts before pagination, puts null dates last and uses stable ID ties', async () => {
    const first = await finding('Alpha', {
      severity: 'low',
      dueAt: new Date('2020-01-01'),
    });
    const second = await finding('Beta', { dueAt: new Date('2020-01-02') });
    await finding('Zulu', { severity: 'critical' });
    expect(
      (
        await list({ sortBy: 'name', sortOrder: 'ASC', limit: 1, page: 2 })
      ).data.map((row) => row.id),
    ).toEqual([second]);
    expect(
      (await list({ sortBy: 'dueAt', sortOrder: 'ASC' })).data
        .slice(0, 2)
        .map((row) => row.id),
    ).toEqual([first, second]);
    expect(
      (await list({ sortBy: 'dueAt', sortOrder: 'DESC' })).data
        .slice(0, 2)
        .map((row) => row.id),
    ).toEqual([second, first]);
    for (const sortBy of [
      'severity',
      'firstDetectedDate',
      'lastSeenDate',
      'firstSeenAt',
      'lastSeenAt',
    ])
      expect((await list({ sortBy, sortOrder: 'ASC' })).total).toBe(3);
  });

  it('counts the whole recorded project with authoritative open/expiry/review semantics', async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86400000);
    await finding('New', { firstDetectedDate: ago(1), dueAt: ago(1) });
    const surfaced = await finding('Resurfaced', {
      detectionStatus: 'resurfaced',
    });
    await insert('vulnerability_events', {
      vulnerabilityId: surfaced,
      workspaceId: owner.workspace.id,
      type: 'status_changed',
      toStatus: 'resurfaced',
      occurredAt: now,
    });
    await finding('Fixed', {
      detectionStatus: 'fixed',
      firstDetectedDate: ago(4),
      fixedAt: ago(2),
    });
    await finding('Pending', { reviewStatus: 'pending_review' });
    await finding('Rejected', { reviewStatus: 'rejected' });
    await finding('Archived', { isArchived: true });
    await dismiss(await finding('Dismissed'));
    await dismiss(
      await finding('Expired', { detectionStatus: 'active' }),
      'risk_accepted',
      ago(1),
    );
    await finding('Unlinked', {}, false);
    await finding('Forged foreign', { assetId: foreignAsset });
    const result = await stats();
    expect(result).toMatchObject({
      byDetectionStatus: { new: 1, active: 1, resurfaced: 1, fixed: 1 },
      newLast7Days: 1,
      resurfacedLast30Days: 1,
      fixedLast30Days: 1,
      overdue: 1,
      pendingReview: 1,
    });
    expect(result.data.find((row) => row.severity === 'high')?.count).toBe(3);
    expect(result.mttr.find((row) => row.severity === 'high')).toMatchObject({
      days: 2,
      count: 1,
    });
    expect(result.mttr.find((row) => row.severity === 'critical')).toEqual({
      severity: 'critical',
      days: null,
      count: 0,
    });
    expect((await stats(headers())).pendingReview).toBeNull();
    await sql('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
    expect(await stats()).toEqual(result);
  });

  it('returns empty totals and preserves ownership, review gates and query rejection', async () => {
    expect(await stats()).toMatchObject({
      pendingReview: 0,
      overdue: 0,
      byDetectionStatus: { new: 0, active: 0, resurfaced: 0, fixed: 0 },
    });
    await request(app.server)
      .get(path() + '/statistics')
      .expect(401);
    await request(app.server)
      .get(path() + '/statistics')
      .set(other.headers)
      .expect(404);
    for (const query of [
      { sortBy: 'id' },
      { sortOrder: 'bad' },
      { overdue: 'yes' },
      { createdFrom: 'invalid' },
      { createdFrom: '2026-02-30' },
      { createdTo: '2026-02-29' },
      { discoveredBy: ['unknown'] },
      { filter: '{bad' },
    ])
      await request(app.server)
        .get(path())
        .set(owner.headers)
        .query(query)
        .expect(400);
    await request(app.server)
      .get(path())
      .set(headers())
      .query({ status: 'pending_review' })
      .expect(403);
  });

  it('binds all filter-tree aliases and more than ten values without token collisions', async () => {
    const [{ id: toolId }] = await app.dataSource.query<{ id: string }[]>('SELECT id FROM tools WHERE name=$1', ['nuclei']);
    const id = await finding('Typed filter', { toolId, cveId: ['CVE-2026-12345'], cweId: ['CWE-79'], ipAddress: '127.0.0.1',
      ports: ['443'], affectedUrl: 'https://argus.example.test/path', cvssScore: '9.1', epssScore: '0.9', tags: ['tls'] });
    const [{ targetId }] = await app.dataSource.query<{ targetId: string }[]>('SELECT "targetId" FROM assets WHERE id=$1', [assetId]);
    const [{ value: host }] = await app.dataSource.query<{ value: string }[]>('SELECT value FROM assets WHERE id=$1', [assetId]);
    const filter = { logic: 'and', items: [
      { field: 'name', op: 'eq', value: 'Typed filter' }, { field: 'severity', op: 'eq', value: 'high' },
      { field: 'host', op: 'eq', value: host }, { field: 'target', op: 'eq', value: targetId },
      { field: 'tool', op: 'eq', value: 'nuclei' }, { field: 'cve', op: 'eq', value: 'CVE-2026-12345' },
      { field: 'cwe', op: 'eq', value: 'CWE-79' }, { field: 'ip', op: 'eq', value: '127.0.0.1' },
      { field: 'port', op: 'eq', value: '443' }, { field: 'affectedUrl', op: 'contains', value: '/path' },
      { field: 'cvssScore', op: 'gte', value: '9' }, { field: 'epssScore', op: 'gte', value: '0.8' },
      { field: 'tag', op: 'eq', value: 'tls' },
    ] };
    expect((await list({ filter: JSON.stringify(filter) })).data.map(row => row.id)).toEqual([id]);
  });
});
