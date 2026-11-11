import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project trigger reads (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string, binding: string, foreignProject: string, role: string;
  const ids = [randomUUID(), randomUUID()].sort();
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  async function fixture(workspace: string) {
    const id = await insert(
      'INSERT INTO projects(name,"workspaceId") VALUES($1,$2)',
      ['Trigger read ' + randomUUID(), workspace],
    );
    const workflow = await insert(
      'INSERT INTO workflows(name,content,"filePath","workspaceId") VALUES($1,$2,$3,$4)',
      ['Legacy scan', '{}', randomUUID() + '.yaml', workspace],
    );
    const link = await insert(
      'INSERT INTO project_workflows("projectId","workflowId",schedule,"jobId") VALUES($1,$2,$3,$4)',
      [id, workflow, '0 6 * * *', 'legacy-scheduler'],
    );
    return { id, workflow, link };
  }
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'trigger-owner');
    reader = await createUserWithWorkspace(app.server, 'trigger-reader');
    const own = await fixture(owner.workspace.id),
      foreign = await fixture(reader.workspace.id);
    project = own.id;
    binding = own.link;
    foreignProject = foreign.id;
    const member = await insert(
      'INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',
      [member, role],
    );
    for (const [i, id] of ids.entries())
      await app.dataSource.query(
        'INSERT INTO project_workflow_triggers(id,"projectWorkflowId",type,cron,event,config,"createdAt","schedulerId","lastFiredAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          id,
          binding,
          i ? 'cron' : 'event',
          i ? '0 8 * * *' : null,
          i ? null : 'project.assets.added',
          JSON.stringify({
            windowMinutes: 5,
            severity: ['critical'],
            password: 'hidden',
            unknown: 'hidden',
          }),
          '2026-11-11T00:00:00Z',
          'private-scheduler',
          '2026-11-11T01:00:00Z',
        ],
      );
    const broken = await insert(
      'INSERT INTO project_workflows("projectId","workflowId") VALUES($1,$2)',
      [project, foreign.workflow],
    );
    for (const link of [foreign.link, broken])
      await app.dataSource.query(
        'INSERT INTO project_workflow_triggers("projectWorkflowId",type) VALUES($1,$2)',
        [link, 'event'],
      );
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  const get = (headers = owner.headers, id = project) =>
    request(app.server).get(`/api/projects/${id}/triggers`).set(headers);
  it('returns only scoped triggers in stable order without exposing private configuration or changing schedules', async () => {
    const before = await app.dataSource.query(
      'SELECT * FROM project_workflows WHERE id=$1',
      [binding],
    );
    const { body } = await get().expect(200);
    expect(body.map((row: { id: string }) => row.id)).toEqual(ids);
    expect(body[0]).toEqual({
      id: ids[0],
      projectWorkflowId: binding,
      type: 'event',
      cron: null,
      event: 'project.assets.added',
      config: { windowMinutes: 5, severity: ['critical'] },
      enabled: true,
      lastFiredAt: '2026-11-11T01:00:00.000Z',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(body[1]).toMatchObject({
      type: 'cron',
      cron: '0 8 * * *',
      event: null,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /hidden|private-scheduler|schedulerId/,
    );
    expect(
      await app.dataSource.query(
        'SELECT * FROM project_workflows WHERE id=$1',
        [binding],
      ),
    ).toEqual(before);
  });
  it('reads archived projects and accepts the existing project and group read aliases', async () => {
    await app.dataSource.query(
      'UPDATE projects SET "archivedAt"=NOW() WHERE id=$1',
      [project],
    );
    for (const permission of ['project.read', 'group.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], role],
      );
      await get({
        ...reader.headers,
        'X-Workspace-Id': owner.workspace.id,
      }).expect(200);
    }
  });
  it('returns an empty list for an owned empty project, 404 for foreign or missing projects, and 400 for invalid IDs', async () => {
    const empty = await fixture(owner.workspace.id);
    expect((await get(owner.headers, empty.id).expect(200)).body).toEqual([]);
    for (const id of [foreignProject, randomUUID()])
      await get(owner.headers, id).expect(404);
    await get(owner.headers, 'invalid').expect(400);
  });
  it('denies missing permissions, nonmembers and anonymous callers', async () => {
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [[], role],
    );
    await get({
      ...reader.headers,
      'X-Workspace-Id': owner.workspace.id,
    }).expect(403);
    await get({
      ...owner.headers,
      'X-Workspace-Id': reader.workspace.id,
    }).expect(403);
    await request(app.server)
      .get(`/api/projects/${project}/triggers`)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
  });
});
