import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { StorageService } from '@/modules/storage/storage.service';
import { ProjectFilesService } from '@/modules/projects/project-files.service';
import { ProjectAgentService } from '@/modules/projects/project-agent.service';
import { ProjectScopeWriteService } from '@/modules/projects/project-scope-write.service';
import { ProjectWorkflowCreateService } from '@/modules/projects/project-workflow-create.service';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectScopeRuleMode, ProjectScopeRuleType } from '@/common/enums/enum';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { AgentsService } from '@/modules/agents/agents.service';
import { AgentLLMConfig } from '@/modules/agents/entities/agent-llm-config.entity';
import { LLMProvider, ReasoningEffort } from '@/modules/agents/enums/agent.enums';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { encryptWithDEK } from '@/common/utils/workspace-encryption.util';
import { encrypt } from '@/common/utils/encryption.util';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project AI context and files (Docker e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let project: string;
  let foreign: string;
  let role: string;
  let storage: StorageService;
  const keys = new Set<string>();
  const insert = async (sql: string, params: unknown[]) => (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', params))[0].id;
  const path = (id = project) => `/api/projects/${id}/files`;
  const api = (method: 'get' | 'post' | 'delete', url = path(), headers?: Record<string, string>) => request(app.server)[method](url).set(headers ?? owner.headers);
  const createProject = async (headers: Record<string, string>, name: string) => (await request(app.server).post('/api/projects').set(headers).send({ name }).expect(201)).body.id as string;
  async function upload(id = project, text = 'Scope notes', name = 'scope.md') {
    const presign = await api('post', path(id) + '/presign').send({ fileName: name, sizeBytes: Buffer.byteLength(text) }).expect(201);
    const receipt = presign.body as { artifactId: string; url: string; fields: Record<string, string> };
    const form = new FormData();
    for (const [key, value] of Object.entries(receipt.fields)) form.set(key, value);
    form.set('file', new Blob([text], { type: name.endsWith('.md') ? 'text/markdown' : 'text/plain' }), name);
    const response = await fetch(receipt.url, { method: 'POST', body: form });
    expect(response.ok).toBe(true);
    const artifact = await app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id: receipt.artifactId });
    keys.add(artifact.objectKey); keys.add(workspaceArtifactUploadKey(owner.workspace.id, artifact.id));
    return receipt.artifactId;
  }
  beforeAll(async () => {
    app = await createTestApp(); await app.app.listen(0); storage = app.app.get(StorageService);
    owner = await createUserWithWorkspace(app.server, 'project-ai-owner'); other = await createUserWithWorkspace(app.server, 'project-ai-other');
    project = await createProject(owner.headers, 'Project context'); foreign = await createProject(other.headers, 'Foreign context');
    const member = await insert('INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)', [owner.workspace.id, other.user.userId]);
    role = await insert('INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3)', [owner.workspace.id, randomUUID(), ['project.read','agent.read','agent.write']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)', [member, role]);
  });
  afterAll(async () => {
    try {
      for (const key of keys) await storage.deleteFile(key, ARTIFACT_BUCKET);
      if (app) await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean), userIds: [owner?.user.userId, other?.user.userId].filter(Boolean) });
    } finally { await closeTestApp(app?.app); }
  });

  it('stores trimmed instructions only on canonical project metadata and rejects invalid lengths', async () => {
    await request(app.server).patch(`/api/projects/${project}`).set(owner.headers).send({ instruction: '  Staging only  ' }).expect(200);
    const view = await request(app.server).get(`/api/projects/${project}`).set(owner.headers).expect(200);
    expect(view.body.instruction).toBe('Staging only');
    await request(app.server).patch(`/api/projects/${project}`).set(owner.headers).send({ instruction: 'x'.repeat(2001) }).expect(400);
    await request(app.server).patch(`/api/projects/${project}`).set(owner.headers).send({ instruction: null }).expect(200);
  });
  it('uses real presigned S3 POST, immutable publication, idempotent completion and detach-only semantics', async () => {
    const file = await upload();
    const completed = await api('post', `${path()}/${file}/complete`).expect(201);
    expect(completed.body).toEqual([expect.objectContaining({ id: file, name: 'scope.md', sizeBytes: 11 })]);
    expect(Object.keys(completed.body[0]).sort()).toEqual(['attachedAt','createdByName','id','mimeType','name','sizeBytes']);
    await storage.uploadFile(workspaceArtifactUploadKey(owner.workspace.id, file), Buffer.from('Replacement'), ARTIFACT_BUCKET, 'text/markdown');
    await api('post', `${path()}/${file}/complete`).expect(201);
    expect((await app.app.get(ProjectFilesService).readText(project, owner.workspace.id, file)).content).toBe('Scope notes');
    const before = await app.dataSource.query('SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id]);
    await api('delete', `${path()}/${file}`).expect(200, []);
    expect(await app.dataSource.query('SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id])).toEqual(before);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).findOneBy({ id: file })).toMatchObject({ status: 'ready' });
    await expect(app.app.get(ProjectFilesService).readText(project, owner.workspace.id, file)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects an instruction save that waited behind a concurrent archive', async () => {
    const blocker = app.dataSource.createQueryRunner(); await blocker.connect(); await blocker.startTransaction();
    try {
      await blocker.query('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
      const pending = request(app.server).patch(`/api/projects/${project}`).set(owner.headers).send({ instruction: 'Must not be saved' }).expect(400).then(response => response);
      let waiting = false;
      for (let n=0; n<100; n++) {
        const [row] = await app.dataSource.query<{ waiting: boolean }[]>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id,"archivedAt" FROM projects%' AND query NOT LIKE '%pg_stat_activity%') AS waiting`);
        if (row.waiting) { waiting = true; break; } await delay(5);
      }
      expect(waiting).toBe(true); await blocker.commitTransaction(); await pending;
      expect((await app.dataSource.query<{ instruction: string | null }[]>('SELECT instruction FROM projects WHERE id=$1', [project]))[0].instruction).toBeNull();
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction(); await blocker.release();
      await app.dataSource.query('UPDATE projects SET "archivedAt"=NULL WHERE id=$1', [project]);
    }
  });
  it('enforces project/creator/tenant permissions, file validation and archived state', async () => {
    const reader = { ...other.headers, 'X-Workspace-Id': owner.workspace.id };
    await api('get', path(), reader).expect(200);
    await api('post', path() + '/presign', reader).send({ fileName: 'scope.txt', sizeBytes: 1 }).expect(403);
    await api('get', path(foreign)).expect(404);
    await api('post', path() + '/presign').send({ fileName: 'image.png', sizeBytes: 1 }).expect(400);
    await api('post', path() + '/presign').send({ fileName: 'scope.txt', sizeBytes: 10485761 }).expect(400);
    const file = await upload();
    await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['project.write'], role]);
    await api('post', `${path()}/${file}/complete`, reader).expect(404);
    await app.dataSource.query('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [project]);
    try {
      await api('post', `${path()}/${file}/complete`).expect(400);
      await api('post', path() + '/presign').send({ fileName: 'scope.txt', sizeBytes: 1 }).expect(400);
      await api('delete', `${path()}/${file}`).expect(400);
    } finally { await app.dataSource.query('UPDATE projects SET "archivedAt"=NULL WHERE id=$1', [project]); }
  });
  it('serializes the sixth attachment across concurrent completions and permits an idempotent repeat at capacity', async () => {
    const id = await createProject(owner.headers, 'Capacity');
    for (let n=0; n<4; n++) { const f = await upload(id); await api('post', `${path(id)}/${f}/complete`).expect(201); }
    const [a,b] = await Promise.all([upload(id), upload(id)]);
    const responses = await Promise.all([a,b].map(f => api('post', `${path(id)}/${f}/complete`)));
    expect(responses.map(r => r.status).sort()).toEqual([201,400]);
    expect((await api('get', path(id)).expect(200)).body).toHaveLength(5);
    const successful = responses[0].status === 201 ? a : b;
    await api('post', `${path(id)}/${successful}/complete`).expect(201);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ id: responses[0].status === 201 ? b : a, status: 'ready' })).toBe(1);
  });
  it('merges concurrent AI scope patches under one project lock', async () => {
    const service = app.app.get(ProjectScopeWriteService);
    await Promise.all(['a.example.test','b.example.test'].map(value => service.patchRules(project, owner.workspace.id, { add: [{ mode: ProjectScopeRuleMode.INCLUDE, type: ProjectScopeRuleType.HOSTNAME, value }] })));
    const rules = await app.dataSource.query<{ value: string }[]>('SELECT value FROM project_scope_rules WHERE "projectId"=$1 ORDER BY value', [project]);
    expect(rules.map(r => r.value)).toEqual(['a.example.test','b.example.test']);
  });
  it('authorizes inspect_asset by service ID and rejects services outside the project', async () => {
    const target = await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)', ['inspect.example.test','DOMAIN',owner.workspace.id]);
    const asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['inspect.example.test',target]);
    const service = await insert('INSERT INTO asset_services (value,port,"assetId") VALUES ($1,$2,$3)', ['inspect.example.test',443,asset]);
    await app.dataSource.query('INSERT INTO project_assets ("projectId","assetId") VALUES ($1,$2)', [project,asset]);
    expect(asset).not.toBe(service);
    await expect(app.app.get(ProjectAgentService).assertToolScope('inspect_asset',project,owner.workspace.id,{ assetId:service },false)).resolves.toBeUndefined();
    await expect(app.app.get(ProjectAgentService).assertToolScope('inspect_asset',project,owner.workspace.id,{ assetId:asset },false)).rejects.toMatchObject({ status:404 });
    await expect(app.app.get(ProjectAgentService).assertToolScope('inspect_asset',foreign,other.workspace.id,{ assetId:service },false)).rejects.toMatchObject({ status:404 });
  });
  it('rolls back workflow creation when Stop arrives while waiting for the project lock', async () => {
    const [template] = await app.dataSource.query<{ filePath: string }[]>('SELECT "filePath" FROM workflows WHERE "workspaceId"=$1 AND "isCanEdit"=false LIMIT 1', [owner.workspace.id]);
    const blocker = app.dataSource.createQueryRunner(); await blocker.connect(); await blocker.startTransaction();
    const stop = new AbortController();
    try {
      await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [project]);
      const pending = app.app.get(ProjectWorkflowCreateService).create(project, owner.workspace.id, { template: template.filePath }, stop.signal);
      const rejected = expect(pending).rejects.toThrow();
      let waiting = false;
      for (let n=0; n<100; n++) {
        const [row] = await app.dataSource.query<{ waiting: boolean }[]>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id, "archivedAt" FROM projects%' AND query NOT LIKE '%pg_stat_activity%') AS waiting`);
        if (row.waiting) { waiting = true; break; } await delay(5);
      }
      expect(waiting).toBe(true); stop.abort(); await blocker.commitTransaction(); await rejected;
      expect(await app.dataSource.query('SELECT id FROM project_workflows WHERE "projectId"=$1', [project])).toEqual([]);
    } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); await blocker.release(); }
  });
  it('creates and links only one project for parallel and sequential calls and cascades its chat on deletion', async () => {
    const conversation = randomUUID();
    await app.dataSource.query('INSERT INTO agent_conversations (id,"workspaceId","createdBy","llmConfigId") VALUES ($1,$2,$3,$4)', [conversation, owner.workspace.id, owner.user.userId, randomUUID()]);
    const service = app.app.get(ProjectAgentService);
    const results = await Promise.all(['One','Two'].map(name => service.createLinked({ name }, owner.workspace.id, owner.user.userId, conversation)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await service.createLinked({ name: 'Three' }, owner.workspace.id, owner.user.userId, conversation)).toBeNull();
    expect(await service.createLinked({ name: 'Foreign actor' }, owner.workspace.id, other.user.userId, conversation)).toBeNull();
    const linked = results.find(Boolean)!;
    await request(app.server).delete(`/api/projects/${linked.id}`).set(owner.headers).expect(200);
    expect(await app.dataSource.query('SELECT id FROM agent_conversations WHERE id=$1', [conversation])).toEqual([]);
  });
  it('persists concurrent partial reasoning changes and explicit null resets without external provider calls', async () => {
    const repo = app.dataSource.getRepository(AgentLLMConfig);
    const dek = await app.app.get(WorkspaceEncryptionService).getDEK(owner.workspace.id);
    const apiKey = dek ? encryptWithDEK('fixture-no-provider-call', dek) : encrypt('fixture-no-provider-call');
    const config = await repo.save(repo.create({ workspaceId: owner.workspace.id, userId: owner.user.userId, createdBy: owner.user.userId, provider: LLMProvider.OPENAI, model: 'gpt-5', apiKey }));
    const service = app.app.get(AgentsService);
    await Promise.all([service.updateLLMConfig(config.id, { model: 'gpt-5-mini' }, owner.workspace.id, owner.user.userId), service.updateLLMConfig(config.id, { reasoningEffort: ReasoningEffort.HIGH }, owner.workspace.id, owner.user.userId)]);
    expect(await repo.findOneByOrFail({ id: config.id })).toMatchObject({ model: 'gpt-5-mini', reasoningEffort: 'high' });
    await service.updateLLMConfig(config.id, { reasoningEffort: null }, owner.workspace.id, owner.user.userId);
    expect((await repo.findOneByOrFail({ id: config.id })).reasoningEffort).toBeNull();
    await expect(service.updateLLMConfig(config.id, { reasoningEffort: ReasoningEffort.LOW }, owner.workspace.id, other.user.userId)).rejects.toMatchObject({ status: 404 });
  });
});
