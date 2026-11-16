import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { getVulnerabilitiesTool } from '@/modules/agents/tools/workspace.tools';
import { ProjectAgentService } from '@/modules/projects/project-agent.service';
import { VulnerabilitiesService } from '@/modules/vulnerabilities/vulnerabilities.service';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';

describe('AI finding lifecycle reads (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>, other: typeof owner;
  let limited: Awaited<ReturnType<typeof createUser>>;
  let roleId: string, assetId: string, targetId: string, foreignAsset: string;
  const insert = async (sql: string, args: unknown[]) =>
    (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args))[0].id;
  const query = (sql: string, args: unknown[]) => app.dataSource.query(sql, args);
  async function asset(workspaceId: string) {
    const host = randomUUID() + '.example.test';
    const target = await insert('INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)', [host, workspaceId]);
    return { target, id: await insert('INSERT INTO assets(value,"targetId") VALUES($1,$2)', [host, target]) };
  }
  async function finding(name: string, options: {
    state?: string; review?: string; source?: string; tags?: string[]; due?: Date;
    detected?: Date | null; created?: Date; severity?: string; asset?: string;
  } = {}) {
    return insert(`INSERT INTO vulnerabilities(name,fingerprint,severity,"assetId","detectionStatus","reviewStatus","discoveredBy",tags,"dueAt","createdAt","firstDetectedDate","fixedAt","timesDetected","cveId")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13)`, [name, randomUUID(), options.severity ?? 'high', options.asset ?? assetId,
      options.state ?? 'new', options.review ?? 'approved', options.source ?? 'tool', options.tags ?? [], options.due ?? null,
      options.created ?? new Date('2010-01-01T12:00:00Z'), options.detected === undefined ? new Date('2020-01-15T12:00:00Z') : options.detected,
      options.state === 'fixed' ? new Date() : null, ['CVE-2020-0001']]);
  }
  async function dismiss(id: string, reason = 'wont_fix', expiresAt: Date | null = null) {
    await query('INSERT INTO vulnerability_dismissals("vulnerabilityId","userId",reason,"expiresAt") VALUES($1,$2,$3,$4)',
      [id, owner.user.userId, reason, expiresAt]);
  }
  async function read(params = {}, userId: string | undefined = owner.user.userId, projectId?: string) {
    const tool = getVulnerabilitiesTool({ vulnerabilitiesService: app.app.get(VulnerabilitiesService),
      workspacesService: app.app.get(WorkspacesService), projectResultsService: app.app.get(ProjectAgentService) },
    owner.workspace.id, { userId, projectId });
    return await tool.execute!(params, { toolCallId: 'docker-findings', messages: [] }) as {
      data: { id: string; name: string; status?: string; openIssue?: unknown; [key: string]: unknown }[];
      total: number; page: number; hasNextPage: boolean;
    };
  }
  beforeAll(async () => {
    app = await createTestApp(); await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'ai-finding-owner');
    other = await createUserWithWorkspace(app.server, 'ai-finding-foreign');
    limited = await createUser(app.server, { name: 'Limited AI finding reader' });
    const member = await insert('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)', [owner.workspace.id, limited.userId]);
    roleId = await insert('INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)',
      ['AI finding read', ['vulnerability.read'], owner.workspace.id]);
    await query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member, roleId]);
  });
  beforeEach(async () => {
    await query('DELETE FROM issues WHERE "workspaceId"=$1', [owner.workspace.id]);
    await query('DELETE FROM projects WHERE "workspaceId"=$1', [owner.workspace.id]);
    await query('DELETE FROM targets WHERE "workspaceId"=ANY($1::uuid[])', [[owner.workspace.id, other.workspace.id]]);
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['vulnerability.read'], roleId]);
    ({ id: assetId, target: targetId } = await asset(owner.workspace.id));
    foreignAsset = (await asset(other.workspace.id)).id;
  });
  afterAll(async () => {
    try {
      if (app) await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, other?.user.userId, limited?.userId].filter(Boolean),
      });
    } finally { await closeTestApp(app?.app); }
  });

  it('applies every lifecycle/review status, defaults to open, and isolates the workspace', async () => {
    for (const [name, state] of [['New', 'new'], ['Active', 'active'], ['Resurfaced', 'resurfaced'], ['Fixed', 'fixed']])
      await finding(name, { state });
    await finding('Pending', { review: 'pending_review', source: 'ai' });
    await finding('Rejected', { review: 'rejected', source: 'ai' });
    await dismiss(await finding('Dismissed', { state: 'active' }));
    await dismiss(await finding('Accepted', { state: 'active' }), 'risk_accepted', new Date(Date.now() + 86400000));
    await dismiss(await finding('Expired', { state: 'active' }), 'risk_accepted', new Date(Date.now() - 86400000));
    await finding('Foreign', { asset: foreignAsset });
    const expected: Record<string, string[]> = {
      open: ['Active', 'Expired', 'New', 'Resurfaced'], new: ['New'], active: ['Active', 'Expired'],
      resurfaced: ['Resurfaced'], fixed: ['Fixed'], dismissed: ['Accepted', 'Dismissed'],
      pending_review: ['Pending'], rejected: ['Rejected'], all: ['Accepted', 'Active', 'Dismissed', 'Expired', 'Fixed', 'New', 'Resurfaced'],
    };
    expect((await read()).data.map(row => row.name).sort()).toEqual(expected.open);
    for (const [status, names] of Object.entries(expected)) {
      const result = await read({ status });
      expect(result.data.map(row => row.name).sort()).toEqual(names);
      expect(result.total).toBe(names.length);
    }
  });

  it('combines source/tag/overdue/target/severity and first-detection date filters', async () => {
    const wanted = await finding('Matched', { state: 'active', source: 'ai', tags: ['web'], due: new Date('2019-01-01') });
    await finding('Wrong source', { tags: ['web'], due: new Date('2019-01-01') });
    await finding('Wrong tag', { source: 'ai', due: new Date('2019-01-01') });
    await finding('Not overdue', { source: 'ai', tags: ['web'], due: new Date(Date.now() + 86400000) });
    await finding('Fixed', { state: 'fixed', source: 'ai', tags: ['web'], due: new Date('2019-01-01') });
    await finding('Other target', { source: 'ai', tags: ['web'], due: new Date('2019-01-01'), asset: (await asset(owner.workspace.id)).id });
    await finding('Foreign', { source: 'ai', tags: ['web'], due: new Date('2019-01-01'), asset: foreignAsset });
    const result = await read({ status: 'all', severity: ['high'], discoveredBy: ['ai'], tags: ['web'], overdue: true,
      targetIds: [targetId], createdFrom: '2020-01-01', createdTo: '2020-01-31' });
    expect(result.total).toBe(1);
    expect(result.data).toEqual([expect.objectContaining({ id: wanted, detectionStatus: 'active', discoveredBy: 'ai', timesDetected: 2 })]);
    // HTTP and model clients now share first-detection date filtering.
    const legacy = await request(app.server).get('/api/vulnerabilities').set(owner.headers)
      .query({ createdFrom: '2020-01-01', createdTo: '2020-01-31' }).expect(200);
    expect((legacy.body as { total: number }).total).toBe(5);
    const fallback = await finding('Legacy date', { detected: null });
    expect((await read({ createdFrom: '2010-01-01', createdTo: '2010-01-31' })).data.map(row => row.id)).toEqual([fallback]);
  });

  it('orders and paginates by severity rather than creation time', async () => {
    const low = await finding('Low', { severity: 'low' });
    const high = await finding('Critical', { severity: 'critical' });
    const first = await read({ limit: 1, page: 1 });
    expect(first.data.map(row => row.id)).toEqual([high]); expect(first.hasNextPage).toBe(true);
    expect((await read({ limit: 1, page: 2 })).data.map(row => row.id)).toEqual([low]);
  });

  it('accepts empty optional filter arrays without generating an empty SQL IN clause', async () => {
    const id = await finding('Unfiltered');
    expect((await read({ targetIds: [], severity: [], discoveredBy: [], tags: [] })).data.map(row => row.id)).toEqual([id]);
  });

  it('returns risk acceptance expiry without exposing dismissal actors or comments', async () => {
    const id = await finding('Accepted finding');
    const expiresAt = new Date(Date.now() + 86400000);
    await dismiss(id, 'risk_accepted', expiresAt);
    await query('UPDATE vulnerability_dismissals SET comment=$1 WHERE "vulnerabilityId"=$2', ['private dismissal comment', id]);
    const result = await read({ status: 'dismissed' });
    expect(result.data[0].dismissal).toEqual({ reason: 'risk_accepted', expiresAt });
    expect(JSON.stringify(result)).not.toContain('private dismissal comment');
    expect(JSON.stringify(result)).not.toContain(owner.user.userId);
  });

  it('includes the last UTC detection day', async () => {
    const late = await finding('Last detection day', { detected: new Date('2020-01-31T23:30:00Z') });
    await finding('Next detection day', { detected: new Date('2020-02-01T00:00:00Z') });
    expect((await read({ createdFrom: '2020-01-31', createdTo: '2020-01-31' })).data.map(row => row.id)).toEqual([late]);
  });

  it('preserves the legacy timestamp clock in first-detection date filters', async () => {
    const legacy = await finding('Legacy boundary', { detected: null, created: new Date(2010, 0, 1, 0, 30) });
    expect((await read({ createdFrom: new Date(2010, 0, 1, 0, 0).toISOString(), createdTo: '2010-01-01' })).data.map(row => row.id)).toEqual([legacy]);
  });

  it('uses current permissions for bounded issue context and denies removed membership', async () => {
    const id = await finding('Linked finding');
    const issueId = await insert('INSERT INTO issues(title,no,"workspaceId","createdById") VALUES($1,1,$2,$3)',
      ['Private issue title', owner.workspace.id, owner.user.userId]);
    await query('INSERT INTO issue_links("issueId","resourceType","resourceId") VALUES($1,\'vulnerability\',$2)', [issueId, id]);
    expect((await read({}, limited.userId)).data[0].openIssue).toBeNull();
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['vulnerability.write', 'workspace.read'], roleId]);
    expect((await read({}, limited.userId)).data[0].openIssue).toEqual({ id: issueId, no: 1, status: 'open' });
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['agent.read'], roleId]);
    await expect(read({}, limited.userId)).rejects.toThrow('vulnerability.read');
    await query('DELETE FROM workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [owner.workspace.id, limited.userId]);
    await expect(read({}, limited.userId)).rejects.toThrow();
  });

  it('aligns project REST and internal lifecycle reads while all remains approved-only', async () => {
    const project = await insert('INSERT INTO projects(name,"workspaceId") VALUES($1,$2)', ['Model lifecycle', owner.workspace.id]);
    const fixed = await finding('Project fixed', { state: 'fixed' });
    const pending = await finding('Project pending', { review: 'pending_review' });
    const rejected = await finding('Project rejected', { review: 'rejected' });
    for (const id of [fixed, pending, rejected])
      await query('INSERT INTO project_vulnerabilities("projectId","vulnerabilityId") VALUES($1,$2)', [project, id]);
    await finding('Unlinked fix', { state: 'fixed' });
    for (const [status, id] of [['fixed', fixed], ['pending_review', pending], ['rejected', rejected]]) {
      const result = await read({ status, projectId: randomUUID() }, owner.user.userId, project);
      expect(result.data.map(row => row.id)).toEqual([id]);
      if (status === 'fixed') expect(result.data[0]).toMatchObject({ status: 'fixed', cveId: ['CVE-2020-0001'], tool: null });
    }
    await request(app.server).get('/api/projects/' + project + '/vulnerabilities').set(owner.headers).query({ status: 'fixed' }).expect(200);
    const legacy = await request(app.server).get('/api/projects/' + project + '/vulnerabilities').set(owner.headers).query({ status: 'all' }).expect(200);
    expect((legacy.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([fixed]);
    expect((legacy.body as { data: { status: string }[] }).data[0].status).toBe('fixed');
    await expect(read({}, other.user.userId, project)).rejects.toThrow();
  });
});
