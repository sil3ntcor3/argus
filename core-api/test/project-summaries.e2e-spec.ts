import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, createUserWithWorkspace } from './helpers/workspace';
import type { ProjectListItemDto } from '../src/modules/projects/dto/project-list-item.dto';

describe('Project summaries and trigger/run context (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>, foreign: typeof owner;
  let reader: Awaited<ReturnType<typeof createUser>>, role: string;
  const query = (sql: string, values: unknown[] = []) => app.dataSource.query(sql, values);
  async function insert(table: string, values: Record<string, unknown>) {
    return (await app.dataSource.query<{ id: string }[]>(`INSERT INTO ${table} (${Object.keys(values).map(k => '"' + k + '"').join(',')})
      VALUES (${Object.keys(values).map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, Object.values(values)))[0].id;
  }
  const headers = () => ({ Cookie: reader.cookie, 'X-Workspace-Id': owner.workspace.id });
  const project = (name = randomUUID(), workspaceId = owner.workspace.id, extra = {}) =>
    insert('projects', { name, workspaceId, description: 'Argus summary', instruction: 'Keep context', ...extra });
  async function asset(workspaceId = owner.workspace.id) {
    const targetId = await insert('targets', { workspaceId, value: randomUUID() + '.example.test', type: 'DOMAIN' });
    return { targetId, id: await insert('assets', { targetId, value: 'summary.example.test' }) };
  }
  async function workflow(projectId: string, workspaceId = owner.workspace.id, name = 'Argus scan') {
    const workflowId = await insert('workflows', { workspaceId, name, filePath: randomUUID() + '.yaml', content: { name, jobs: {} } });
    return { workflowId, projectId, id: await insert('project_workflows', { projectId, workflowId }) };
  }
  const trigger = (binding: string, extra = {}) => insert('project_workflow_triggers', {
    projectWorkflowId: binding, type: 'event', event: 'project.run.completed', enabled: true,
    config: { secret: 'must not escape' }, schedulerId: 'private scheduler', ...extra,
  });
  const run = (binding: Awaited<ReturnType<typeof workflow>>, extra = {}) => insert('job_histories', {
    projectId: binding.projectId, projectWorkflowId: binding.id, workflowId: binding.workflowId,
    createdAt: new Date('2020-01-01T12:00:00Z'), jobRunType: 'event', ...extra,
  });
  async function finding(projectId: string, assetId: string, extra: Record<string, unknown> = {}, firstSeenAt = new Date()) {
    const id = await insert('vulnerabilities', { assetId, name: randomUUID(), fingerprint: randomUUID(), severity: 'high',
      detectionStatus: 'active', reviewStatus: 'approved', firstDetectedDate: new Date('2010-01-01T00:00:00Z'), ...extra });
    await insert('project_vulnerabilities', { projectId, vulnerabilityId: id, firstSeenAt });
    return id;
  }
  const dismiss = (id: string, expiresAt?: Date) => insert('vulnerability_dismissals', {
    vulnerabilityId: id, userId: owner.user.userId, reason: expiresAt ? 'risk_accepted' : 'wont_fix', expiresAt: expiresAt ?? null,
  });
  async function list(params = {}, auth = owner.headers) {
    return (await request(app.server).get('/api/projects').set(auth).query(params).expect(200)).body as {
      data: ProjectListItemDto[]; total: number; pageCount: number;
    };
  }
  async function runs(id: string, auth = owner.headers) {
    return (await request(app.server).get(`/api/projects/${id}/runs`).set(auth).expect(200)).body.data as Record<string, any>[];
  }
  async function overview(id: string) {
    return (await request(app.server).get(`/api/projects/${id}/overview`).set(owner.headers).expect(200)).body as {
      activity: Record<string, any>[];
    };
  }
  beforeAll(async () => {
    app = await createTestApp(); await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'summaries-owner');
    foreign = await createUserWithWorkspace(app.server, 'summaries-foreign');
    reader = await createUser(app.server, { name: 'Summary reader' });
    const member = await insert('workspace_members', { workspaceId: owner.workspace.id, userId: reader.userId });
    role = await insert('workspace_permissions', { workspaceId: owner.workspace.id, name: 'Summary access', permissions: ['project.read'] });
    await insert('workspace_member_permissions', { memberId: member, permissionId: role });
  });
  beforeEach(async () => {
    await query('DELETE FROM job_histories WHERE "workflowId" IN (SELECT id FROM workflows WHERE "workspaceId"=ANY($1::uuid[]))', [[owner.workspace.id, foreign.workspace.id]]);
    await query('DELETE FROM projects WHERE "workspaceId"=ANY($1::uuid[])', [[owner.workspace.id, foreign.workspace.id]]);
    await query('DELETE FROM targets WHERE "workspaceId"=ANY($1::uuid[])', [[owner.workspace.id, foreign.workspace.id]]);
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.read'], role]);
  });
  afterAll(async () => {
    try { if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, foreign?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, foreign?.user.userId, reader?.userId].filter(Boolean),
    }); } finally { await closeTestApp(app?.app); }
  });

  it('counts open approved findings from recorded project links with lifecycle, expiry and workspace guards', async () => {
    const id = await project('Summary counts'), local = await asset(), outside = await asset(foreign.workspace.id);
    await insert('project_assets', { projectId: id, assetId: local.id });
    await insert('project_assets', { projectId: id, assetId: outside.id });
    await finding(id, local.id, { severity: 'critical' });
    await finding(id, local.id, { severity: 'low' }, new Date(Date.now() - 8 * 86400000));
    await finding(id, local.id, { severity: 'medium', detectionStatus: 'resurfaced' });
    await finding(id, local.id, { severity: 'high' }, new Date(Date.now() + 86400000));
    await finding(id, local.id, { detectionStatus: 'fixed' });
    await finding(id, local.id, { isArchived: true });
    await finding(id, local.id, { reviewStatus: 'pending_review' });
    await finding(id, local.id, { reviewStatus: 'rejected' });
    await finding(id, outside.id, { severity: 'critical' });
    await dismiss(await finding(id, local.id));
    await dismiss(await finding(id, local.id), new Date(Date.now() + 86400000));
    await dismiss(await finding(id, local.id), new Date(Date.now() - 86400000));
    const row = (await list()).data[0];
    expect(row).toMatchObject({ id, totalAssets: 1, workflowCount: 0, instruction: 'Keep context',
      openVulnerabilities: { critical: 1, high: 2, medium: 1, low: 1, info: 0 }, newVulnerabilities: 3 });
    await query('DELETE FROM project_assets WHERE "projectId"=$1', [id]);
    expect((await list()).data[0]).toMatchObject({ totalAssets: 0, newVulnerabilities: 3 });
  });

  it('returns sanitized summaries only for valid bindings and preserves archived metadata', async () => {
    const id = await project('Summary triggers'), binding = await workflow(id), outside = await workflow(id, foreign.workspace.id);
    const cron = await trigger(binding.id, { type: 'cron', cron: '0 8 * * *', event: null });
    const event = await trigger(binding.id, { enabled: false });
    await trigger(outside.id); await trigger(binding.id, { type: 'unknown' });
    const row = (await list()).data[0];
    expect(row.workflowCount).toBe(1);
    expect(row.triggers).toEqual([expect.objectContaining({ id: cron, type: 'cron', cron: '0 8 * * *', event: null, enabled: true }),
      expect.objectContaining({ id: event, type: 'event', event: 'project.run.completed', enabled: false })]);
    expect(JSON.stringify(row.triggers)).not.toMatch(/scheduler|secret|config|lastFiredAt/);
    const archivedAt = new Date(); await query('UPDATE projects SET "archivedAt"=$1 WHERE id=$2', [archivedAt, id]);
    expect((await list()).data).toEqual([]);
    expect((await list({ status: 'archived' })).data[0]).toMatchObject({ id, archivedAt: archivedAt.toISOString(), workflowCount: 1 });
    await request(app.server).get(`/api/projects/${id}`).set(owner.headers).expect(200).expect(response => {
      expect(response.body).not.toHaveProperty('workflowCount');
    });
  });

  it('redacts finding summaries and forbids risk sorting without effective finding access', async () => {
    const id = await project(), a = await asset(); await finding(id, a.id);
    expect((await list({}, headers())).data[0]).toMatchObject({ openVulnerabilities: null, newVulnerabilities: null });
    await request(app.server).get('/api/projects').set(headers()).query({ sortBy: 'risk' }).expect(403);
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.write', 'vulnerability.write'], role]);
    expect((await list({ sortBy: 'risk' }, headers())).data[0]).toMatchObject({ newVulnerabilities: 1, openVulnerabilities: { high: 1 } });
  });

  it('sorts risk before pagination with stable ties and keeps search/target/archive filters', async () => {
    const low = await project('Summary A high'), high = await project('Summary Z critical'), tie = await project('Summary critical tie');
    const a = await asset();
    await finding(low, a.id); await finding(high, a.id, { severity: 'critical' }); await finding(tie, a.id, { severity: 'critical' });
    await insert('project_assets', { projectId: high, assetId: a.id });
    const expected = [high, tie].sort().concat(low);
    const first = await list({ sortBy: 'risk', sortOrder: 'DESC', page: 1, limit: 1 });
    expect(first).toMatchObject({ total: 3, pageCount: 3 }); expect(first.data.map(r => r.id)).toEqual(expected.slice(0, 1));
    expect((await list({ sortBy: 'risk', sortOrder: 'DESC', page: 2, limit: 1 })).data.map(r => r.id)).toEqual(expected.slice(1, 2));
    expect((await list({ sortBy: 'risk', sortOrder: 'ASC' })).data[0].id).toBe(low);
    expect((await list({ sortBy: 'risk', page: 9 })).data).toEqual([]);
    expect((await list({ targetIds: [a.targetId], search: 'Summary', sortBy: 'risk' })).data.map(r => r.id)).toEqual([high]);
    const outside = await project('Foreign Summary', foreign.workspace.id); expect((await list()).data.map(r => r.id)).not.toContain(outside);
  });

  it('projects valid trigger and same-workspace cause context, redacts cause fields for project-only readers', async () => {
    const id = await project(), binding = await workflow(id), source = await workflow(await project(), owner.workspace.id, 'Source scan');
    const tr = await trigger(binding.id), cause = await run(source), target = await run(binding, { triggerId: tr, causedByRunId: cause });
    expect((await runs(id))[0]).toMatchObject({ id: target, triggerType: 'event', triggerEvent: 'project.run.completed',
      causedByRunId: cause, causedByWorkflowName: 'Source scan' });
    expect((await runs(id, headers()))[0]).toMatchObject({ triggerType: 'event', causedByRunId: null, causedByWorkflowName: null });
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.read', 'job.write'], role]);
    expect((await runs(id, headers()))[0].causedByRunId).toBe(cause);
    expect(JSON.stringify(await runs(id))).not.toMatch(/chainDepth|schedulerId|workflowContent|triggerId|private scheduler/);
    expect((await overview(id)).activity.find(e => e.ref === target)).toHaveProperty('triggerEvent', 'project.run.completed');
  });

  it('ignores forged triggers/foreign causes and tolerates trigger or cause deletion', async () => {
    const id = await project(), binding = await workflow(id), sibling = await workflow(await project());
    const foreignBinding = await workflow(await project('Outside', foreign.workspace.id), foreign.workspace.id, 'Private cause name');
    const tr = await trigger(sibling.id), cause = await run(foreignBinding), target = await run(binding, { triggerId: tr, causedByRunId: cause });
    expect((await runs(id))[0]).toMatchObject({ triggerType: null, triggerEvent: null, causedByRunId: null, causedByWorkflowName: null });
    const validTrigger = await trigger(binding.id), validCause = await run(sibling);
    await query('UPDATE job_histories SET "triggerId"=$1,"causedByRunId"=$2 WHERE id=$3', [validTrigger, validCause, target]);
    await query('DELETE FROM project_workflow_triggers WHERE id=$1', [validTrigger]);
    await query('DELETE FROM job_histories WHERE id=$1', [validCause]);
    expect((await runs(id))[0]).toMatchObject({ triggerType: null, triggerEvent: null, causedByRunId: null, causedByWorkflowName: null });
  });

  it('rejects an inconsistent cause binding and self-referential cause', async () => {
    const id = await project(), binding = await workflow(id), source = await workflow(await project());
    const cause = await run(source, { projectWorkflowId: binding.id });
    const target = await run(binding, { causedByRunId: cause });
    expect((await runs(id))[0]).toMatchObject({ causedByRunId: null, causedByWorkflowName: null });
    await query('UPDATE job_histories SET "causedByRunId"=id WHERE id=$1', [target]);
    expect((await runs(id))[0]).toMatchObject({ causedByRunId: null, causedByWorkflowName: null });
  });

  it('includes historical risk acceptances and exposes only validated recorded change scalars', async () => {
    const id = await project(), a = await asset(); await dismiss(await finding(id, a.id), new Date(Date.now() - 86400000));
    const audit = async (changes: unknown, extra = {}) => insert('audit_events', { eventId: randomUUID(), workspaceId: owner.workspace.id,
      resourceType: 'project', resourceId: id, action: 'project.created', outcome: 'success', actorType: 'api_key', actorName: 'secret-key-name',
      changes, metadata: { password: 'private metadata' }, ...extra });
    await audit({ name: { after: 'Recorded project' }, autoAddAssets: { before: false, after: true },
      instruction: { after: 'private instructions' }, password: { after: 'private secret' },
      description: { after: { unsafe: 'object' } }, hexColor: { after: 'bad color' } });
    await audit({ name: { after: ['malformed'] }, autoAddAssets: { after: 'true' } });
    const feed = (await overview(id)).activity;
    expect(feed).toContainEqual(expect.objectContaining({ kind: 'dismissed', reason: 'risk_accepted', count: 1 }));
    const entry = feed.find(e => e.kind === 'audit' && e.changes?.name);
    expect(entry).toMatchObject({ actorName: 'API key', changes: { name: { after: 'Recorded project' }, autoAddAssets: { before: false, after: true } } });
    expect(Object.keys(entry!.changes).sort()).toEqual(['autoAddAssets', 'name']);
    expect(JSON.stringify(feed)).not.toMatch(/private metadata|private secret|private instructions|secret-key-name|malformed/);
  });

  it('retains authentication, tenant and validation boundaries', async () => {
    await project(); const outside = await project('Outside', foreign.workspace.id);
    await request(app.server).get('/api/projects').expect(401);
    await request(app.server).get(`/api/projects/${outside}/runs`).set(owner.headers).expect(404);
    for (const params of [{ page: 1.5 }, { limit: 101 }, { sortBy: 'x;DROP' }])
      await request(app.server).get('/api/projects').set(owner.headers).query(params).expect(400);
  });
});
