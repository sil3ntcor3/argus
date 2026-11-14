import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

interface Page {
  data: { id: string; name: string; status?: string }[];
  total: number;
  severityCounts: Record<string, number>;
  provenanceCounts: { all: number };
}

describe('Finding REST lifecycle/date alignment (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>, other: typeof owner;
  let reader: Awaited<ReturnType<typeof createUser>>, roleId: string;
  let project: string, foreignProject: string, assetId: string, foreignAsset: string;
  const sql = (text: string, args: unknown[]) => app.dataSource.query(text, args);
  const insert = async (text: string, args: unknown[]) =>
    (await app.dataSource.query<{ id: string }[]>(text + ' RETURNING id', args))[0].id;
  async function asset(workspaceId: string) {
    const host = randomUUID() + '.example.test';
    const target = await insert('INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)', [host, workspaceId]);
    return insert('INSERT INTO assets(value,"targetId") VALUES($1,$2)', [host, target]);
  }
  async function finding(name: string, options: {
    state?: string; review?: string; severity?: string; archived?: boolean;
    asset?: string; linked?: boolean; created?: Date; detected?: Date | null;
  } = {}) {
    const id = await insert(`INSERT INTO vulnerabilities(name,fingerprint,severity,"assetId","detectionStatus","reviewStatus","isArchived","createdAt","firstDetectedDate","fixedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [name, randomUUID(), options.severity ?? 'high', options.asset ?? assetId,
      options.state ?? 'new', options.review ?? 'approved', options.archived ?? false,
      options.created ?? new Date('2010-01-01T12:00:00Z'), options.detected === undefined ? new Date('2020-01-15T12:00:00Z') : options.detected,
      options.state === 'fixed' ? new Date() : null]);
    if (options.linked !== false) await sql('INSERT INTO project_vulnerabilities("projectId","vulnerabilityId") VALUES($1,$2)', [project, id]);
    return id;
  }
  async function dismiss(id: string, expiresAt?: Date) {
    await sql('INSERT INTO vulnerability_dismissals("vulnerabilityId","userId",reason,"expiresAt") VALUES($1,$2,$3,$4)',
      [id, owner.user.userId, expiresAt ? 'risk_accepted' : 'wont_fix', expiresAt ?? null]);
  }
  const readerHeaders = () => ({ Cookie: reader.cookie, 'X-Workspace-Id': owner.workspace.id });
  async function list(query = {}, id = project, headers = owner.headers) {
    const response = await request(app.server).get('/api/projects/' + id + '/vulnerabilities').set(headers).query(query).expect(200);
    return response.body as Page;
  }
  async function global(query: Record<string, string>) {
    const response = await request(app.server).get('/api/vulnerabilities').set(owner.headers).query(query).expect(200);
    return response.body as Page;
  }
  beforeAll(async () => {
    app = await createTestApp(); await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'finding-rest-owner');
    other = await createUserWithWorkspace(app.server, 'finding-rest-foreign');
    reader = await createUser(app.server, { name: 'Project-only finding reader' });
    const member = await insert('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)', [owner.workspace.id, reader.userId]);
    roleId = await insert('INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)', ['Project findings', ['project.read'], owner.workspace.id]);
    await sql('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member, roleId]);
  });
  beforeEach(async () => {
    await sql('DELETE FROM projects WHERE "workspaceId"=ANY($1::uuid[])', [[owner.workspace.id, other.workspace.id]]);
    await sql('DELETE FROM targets WHERE "workspaceId"=ANY($1::uuid[])', [[owner.workspace.id, other.workspace.id]]);
    await sql('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.read'], roleId]);
    project = await insert('INSERT INTO projects(name,"workspaceId") VALUES($1,$2)', ['REST lifecycle', owner.workspace.id]);
    foreignProject = await insert('INSERT INTO projects(name,"workspaceId") VALUES($1,$2)', ['Foreign REST lifecycle', other.workspace.id]);
    assetId = await asset(owner.workspace.id); foreignAsset = await asset(other.workspace.id);
  });
  afterAll(async () => {
    try { if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId, reader?.userId].filter(Boolean),
    }); } finally { await closeTestApp(app?.app); }
  });

  it('filters by first detection with legacy fallback and preserves other filters', async () => {
    const detected = await finding('Detected now');
    const legacy = await finding('Legacy date', { detected: null, created: new Date('2020-01-15T12:00:00Z') });
    await finding('Created now but detected earlier', { created: new Date('2020-01-15T12:00:00Z'), detected: new Date('2019-01-01T12:00:00Z') });
    await finding('Foreign', { asset: foreignAsset });
    const query = { createdFrom: '2020-01-01', createdTo: '2020-01-31' };
    expect((await global(query)).data.map(row => row.id).sort()).toEqual([detected, legacy].sort());
    expect((await global({ ...query, q: 'Detected now' })).data.map(row => row.id)).toEqual([detected]);
  });

  it('includes the full UTC end date and handles legacy local timestamps', async () => {
    const late = await finding('Last UTC day', { detected: new Date('2020-01-31T23:59:59Z') });
    await finding('Next UTC day', { detected: new Date('2020-02-01T00:00:00Z') });
    expect((await global({ createdFrom: '2020-01-31', createdTo: '2020-01-31' })).data.map(row => row.id)).toEqual([late]);
    const legacy = await finding('Legacy boundary', { detected: null, created: new Date(2011, 0, 1, 0, 30) });
    expect((await global({ createdFrom: new Date(2011, 0, 1, 0).toISOString(), createdTo: '2011-01-01' })).data.map(row => row.id)).toEqual([legacy]);
  });

  it('supports every project lifecycle/review filter while open/all exclude proposals', async () => {
    for (const [name, state] of [['New', 'new'], ['Active', 'active'], ['Resurfaced', 'resurfaced'], ['Fixed', 'fixed']]) await finding(name, { state });
    await finding('Pending', { review: 'pending_review' }); await finding('Rejected', { review: 'rejected' });
    await finding('Archived', { archived: true });
    await dismiss(await finding('Dismissed', { state: 'active' }));
    await dismiss(await finding('Accepted', { state: 'active' }), new Date(Date.now() + 86400000));
    await dismiss(await finding('Expired', { state: 'active' }), new Date(Date.now() - 86400000));
    await finding('Unlinked', { linked: false }); await finding('Forged foreign link', { asset: foreignAsset });
    const expected: Record<string, string[]> = { open: ['Active', 'Expired', 'New', 'Resurfaced'],
      new: ['New'], active: ['Active', 'Expired'], resurfaced: ['Resurfaced'], fixed: ['Fixed'],
      dismissed: ['Accepted', 'Dismissed'], pending_review: ['Pending'], rejected: ['Rejected'],
      all: ['Accepted', 'Active', 'Archived', 'Dismissed', 'Expired', 'Fixed', 'New', 'Resurfaced'] };
    expect((await list()).data.map(row => row.name).sort()).toEqual(expected.open);
    for (const [status, names] of Object.entries(expected)) {
      const result = await list({ status }); expect(result.total).toBe(names.length);
      expect(result.data.map(row => row.name).sort()).toEqual(names);
    }
  });

  it('returns fixed resolution labels on lists and approved finding timelines', async () => {
    const id = await finding('Fixed and dismissed', { state: 'fixed' }); await dismiss(id);
    expect((await list({ status: 'all' })).data[0]).toMatchObject({ id, status: 'fixed' });
    const response = await request(app.server).get(`/api/projects/${project}/vulnerabilities/${id}/timeline`).set(owner.headers).expect(200);
    expect((response.body as { vulnerability: { status: string } }).vulnerability.status).toBe('fixed');
    const pending = await finding('Pending timeline', { review: 'pending_review' });
    await request(app.server).get(`/api/projects/${project}/vulnerabilities/${pending}/timeline`).set(owner.headers).expect(404);
  });

  it('requires vulnerability access for review filters without restricting approved project reads', async () => {
    const fixed = await finding('Fixed', { state: 'fixed' }); const pending = await finding('Pending', { review: 'pending_review' });
    expect((await list({ status: 'fixed' }, project, readerHeaders())).data.map(row => row.id)).toEqual([fixed]);
    for (const status of ['pending_review', 'rejected']) await request(app.server).get(`/api/projects/${project}/vulnerabilities`).set(readerHeaders()).query({ status }).expect(403);
    await sql('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.write', 'vulnerability.write'], roleId]);
    expect((await list({ status: 'pending_review' }, project, readerHeaders())).data.map(row => row.id)).toEqual([pending]);
    await sql('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.read'], roleId]);
    await request(app.server).get(`/api/projects/${project}/vulnerabilities`).set(readerHeaders()).query({ status: 'pending_review' }).expect(403);
  });

  it('keeps facets scoped to the selected review status and independent severity filter', async () => {
    const high = await finding('Pending high', { review: 'pending_review' });
    await finding('Pending critical', { review: 'pending_review', severity: 'critical' });
    await finding('Approved critical', { severity: 'critical' });
    await finding('Foreign pending', { asset: foreignAsset, review: 'pending_review', severity: 'critical' });
    const result = await list({ status: 'pending_review', severity: ['high'] });
    expect(result.data.map(row => row.id)).toEqual([high]); expect(result.total).toBe(1);
    expect(result.severityCounts).toMatchObject({ high: 1, critical: 1 }); expect(result.provenanceCounts.all).toBe(1);
  });

  it('retains authentication, tenant boundaries and invalid-filter rejection', async () => {
    await request(app.server).get(`/api/projects/${project}/vulnerabilities`).expect(401);
    await request(app.server).get(`/api/projects/${foreignProject}/vulnerabilities`).set(owner.headers).query({ status: 'fixed' }).expect(404);
    await request(app.server).get(`/api/projects/${project}/vulnerabilities`).set(owner.headers).query({ status: 'invalid' }).expect(400);
    await request(app.server).get('/api/vulnerabilities').set(owner.headers).query({ createdFrom: 'invalid' }).expect(400);
  });
});
