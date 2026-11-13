import { JobsRegistryController } from '@/modules/jobs-registry/jobs-registry.controller';
import { JobsRegistryService } from '@/modules/jobs-registry/jobs-registry.service';
import { WorkflowRunnerService } from '@/modules/jobs-registry/workflow-runner.service';
import { SAVED_TEMPLATE_SELECTION } from '@/modules/jobs-registry/saved-template-dispatch';
import type { GetNextJobResult } from '@/modules/jobs-registry/dto/jobs-registry.dto';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { StorageService } from '@/modules/storage/storage.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

type WireValue = { stringValue?: string; structValue?: { fields: Record<string, WireValue> }; listValue?: { values: WireValue[] } };
function decode(value: WireValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.listValue) return value.listValue.values.map(decode);
  if (value.structValue) return Object.fromEntries(Object.entries(value.structValue.fields).map(([key, field]) => [key, decode(field)]));
  return undefined;
}

describe('saved template runs and actual worker dispatch (Docker e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let targetId: string;
  let assetId: string;
  let projectId: string;
  let workerId: string;
  let roleId: string;
  const yaml = 'id: argus-dispatch\n';
  const insert = async (sql: string, values: unknown[]) => (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  const create = async () => (await request(app.server).post('/api/templates').set(owner.headers).send({ name: 'dispatch.yaml', content: yaml }).expect(201)).body as { id: string };
  const run = (id: string, scope = { targetIds: [targetId] } as Record<string, string[]>) => request(app.server).post('/api/templates/run').set(owner.headers).send({ templateIds: [id], ...scope });
  const jobs = () => app.dataSource.query<{ id: string; inputs: Record<string, string>; config: unknown; status: string }[]>(
    'SELECT id,inputs,config,status FROM jobs WHERE "assetId"=$1 ORDER BY "createdAt",id', [assetId]);

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'template-run-owner');
    foreign = await createUserWithWorkspace(app.server, 'template-run-foreign');
    targetId = await insert('INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)', ['template-run.example.test', owner.workspace.id]);
    assetId = await insert('INSERT INTO assets(value,"targetId","isEnabled") VALUES($1,$2,true)', ['template-run.example.test', targetId]);
    projectId = await insert('INSERT INTO projects(name,"workspaceId") VALUES($1,$2)', ['Template run project', owner.workspace.id]);
    await app.dataSource.query('INSERT INTO project_assets("projectId","assetId") VALUES($1,$2)', [projectId, assetId]);
    workerId = await insert('INSERT INTO workers(name,"workspaceId","runMode",token) VALUES($1,$2,\'node\',$3)', ['Argus template fixture', owner.workspace.id, randomUUID()]);
    await app.dataSource.query('INSERT INTO workspace_tools("workspaceId","toolId","isEnabled") SELECT $1,id,true FROM tools WHERE name=\'nuclei\' AND NOT EXISTS(SELECT 1 FROM workspace_tools wt WHERE wt."workspaceId"=$1 AND wt."toolId"=tools.id)', [owner.workspace.id]);
    roleId = (await app.dataSource.query<{ id: string }[]>('SELECT id FROM workspace_permissions WHERE "workspaceId"=$1', [owner.workspace.id]))[0].id;
  });
  afterEach(async () => {
    await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['*'], roleId]);
    await app.dataSource.query('DELETE FROM job_histories WHERE id IN (SELECT "jobHistoryId" FROM jobs WHERE "assetId"=$1)', [assetId]);
    await app.app.get(StorageService).deleteWorkspaceArtifacts(owner.workspace.id);
    await app.dataSource.query('DELETE FROM artifacts WHERE "workspaceId"=$1', [owner.workspace.id]);
    await app.dataSource.query('DELETE FROM artifact_folders WHERE "workspaceId"=$1', [owner.workspace.id]);
    await app.dataSource.query('DELETE FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id]);
  });
  afterAll(async () => {
    if (app) { await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id, foreign?.workspace.id].filter(Boolean), userIds: [owner?.user.userId, foreign?.user.userId].filter(Boolean) }); await closeTestApp(app.app); }
  });

  it.each(['targetIds', 'assetIds', 'projectIds'])('queues exactly the selected templates for %s and signs the latest content at claim', async kind => {
    const template = await create();
    const id = kind === 'targetIds' ? targetId : kind === 'assetIds' ? assetId : projectId;
    await run(template.id, { [kind]: [id] }).expect(response => { if (response.status !== 201) throw new Error(JSON.stringify(response.body)); }).expect(201);
    const [queued] = await jobs();
    expect(queued.inputs[SAVED_TEMPLATE_SELECTION]).toContain(template.id);
    expect(queued.config ?? {}).not.toHaveProperty('customTemplates');
    await request(app.server).put(`/api/templates/${template.id}/content`).set(owner.headers).send({ content: 'id: latest-revision\n' }).expect(200);
    const { values } = await app.app.get(JobsRegistryController).nextBatch({ id: workerId, limit: 10 });
    expect(values).toHaveLength(1);
    expect(JSON.stringify(values)).not.toContain(SAVED_TEMPLATE_SELECTION);
    const config = decode({ structValue: values[0].config as { fields: Record<string, WireValue> } }) as { customTemplates: { url: string; cacheKey: string }[] };
    expect(config.customTemplates).toHaveLength(1);
    expect(config.customTemplates[0].cacheKey).toContain(template.id);
    expect(await (await fetch(config.customTemplates[0].url)).text()).toBe('id: latest-revision\n');
    expect(JSON.stringify(await jobs())).not.toContain('X-Amz-Signature');
    const visible = await request(app.server).get('/api/jobs-registry').set(owner.headers).expect(200);
    expect(JSON.stringify(visible.body)).not.toContain(SAVED_TEMPLATE_SELECTION);
    const [history] = await app.dataSource.query<{ id: string }[]>('SELECT "jobHistoryId" AS id FROM jobs WHERE id=$1', [queued.id]);
    await request(app.server).get(`/api/jobs-registry/histories/${history.id}`).set(owner.headers).expect(200);
    await request(app.server).get(`/api/jobs-registry/histories/${history.id}`).set(foreign.headers).expect(404);
    await app.dataSource.query('UPDATE jobs SET status=\'completed\' WHERE id=$1', [queued.id]);
    await app.app.get(WorkflowRunnerService).advanceRun(history.id);
    const [settled] = await app.dataSource.query<{ isCompleted: boolean }[]>('SELECT "isCompleted" FROM job_histories WHERE id=$1', [history.id]);
    expect(settled.isCompleted).toBe(true);
  });

  it('fails closed after permission revocation and keeps cancellation intact', async () => {
    const template = await create(); await run(template.id).expect(201);
    await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [['artifact.read'], roleId]);
    expect((await app.app.get(JobsRegistryController).nextBatch({ id: workerId, limit: 10 })).values).toEqual([]);
    expect((await jobs())[0].status).toBe('failed');
    const job = (await jobs())[0];
    const [claim] = await app.dataSource.query<{ pickJobAt: Date }[]>('SELECT "pickJobAt" FROM jobs WHERE id=$1', [job.id]);
    await app.dataSource.query('UPDATE jobs SET status=\'cancelled\' WHERE id=$1', [job.id]);
    await app.app.get(JobsRegistryService).failTemplateDispatch({ id: job.id, dispatchClaimAt: claim.pickJobAt } as GetNextJobResult, workerId);
    expect((await jobs())[0].status).toBe('cancelled');
  });

  it('rejects empty/mixed/foreign scopes and missing selected templates before queueing', async () => {
    const template = await create();
    for (const scope of [{}, { targetIds: [] }, { targetIds: [targetId], assetIds: [assetId] }]) await run(template.id, scope).expect(400);
    await run(template.id, { targetIds: [randomUUID()] }).expect(404);
    await run(randomUUID()).expect(404);
    await request(app.server).post('/api/templates/run').set(foreign.headers).send({ templateIds: [template.id], targetIds: [targetId] }).expect(404);
    expect(await jobs()).toEqual([]);
  });

  it('does not let another job writer rerun a private template as its original actor', async () => {
    const template = await create(); await run(template.id).expect(201);
    const [job] = await jobs();
    const member = await insert('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)', [owner.workspace.id, foreign.user.userId]);
    const role = await insert('INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3)', [owner.workspace.id, 'Job writer only', ['job.write']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member, role]);
    await request(app.server).post(`/api/jobs-registry/${job.id}/re-run`).set({ ...foreign.headers, 'X-Workspace-Id': owner.workspace.id }).expect(400);
    expect((await jobs())[0].inputs[SAVED_TEMPLATE_SELECTION]).toBe(job.inputs[SAVED_TEMPLATE_SELECTION]);
    expect((await jobs())[0].status).toBe('pending');
  });
});
