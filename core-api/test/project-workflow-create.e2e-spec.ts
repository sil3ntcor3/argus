import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { EntityManager } from 'typeorm';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project workflow creation API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let projectId: string;
  let foreignId: string;
  let role: string;
  const template = randomUUID() + '.yaml';
  const jobs = {
    probe: { run: 'httpx' },
    scan: { run: 'nuclei', needs: ['probe'] },
  };
  const source = {
    name: 'Default scan',
    jobs,
    on: { schedule: '0 0 * * *', target: ['domain.create'] },
  };
  const url = (id = projectId) => '/api/projects/' + id + '/workflows';
  const post = (body: object, id?: string, headers = owner.headers) =>
    request(app.server).post(url(id)).set(headers).send(body);
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'workflow-create-owner');
    other = await createUserWithWorkspace(app.server, 'workflow-create-other');
    for (const [filePath, workspace, editable] of [
      [template, owner.workspace.id, false],
      ['editable-' + template, owner.workspace.id, true],
      ['foreign-' + template, other.workspace.id, false],
    ] as const) {
      await insert(
        'INSERT INTO workflows (name,content,"filePath","workspaceId","isCanEdit") VALUES ($1,$2,$3,$4,$5)',
        [source.name, JSON.stringify(source), filePath, workspace, editable],
      );
    }
    const createProject = async (headers: typeof owner.headers, name: string) =>
      (
        await request(app.server)
          .post('/api/projects')
          .set(headers)
          .send({ name })
          .expect(201)
      ).body.id as string;
    projectId = await createProject(owner.headers, 'Owned project');
    foreignId = await createProject(other.headers, 'Foreign project');
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, other.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
  });

  afterAll(async () => {
    try {
      if (app)
        await cleanupE2eData(app.dataSource, {
          workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
            Boolean,
          ),
          userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
        });
    } finally {
      await closeTestApp(app?.app);
    }
  });

  it('copies the default pipeline into an owned disabled binding and returns only the receipt', async () => {
    const { body } = await post({ template, name: '  Project scan  ' }).expect(
      201,
    );
    expect(body).toEqual({
      id: expect.any(String),
      workflowId: expect.any(String),
      name: 'Project scan',
      schedule: 'disabled',
    });
    const [binding] = await app.dataSource.query(
      'SELECT "projectId","workflowId",schedule,"jobId" FROM project_workflows WHERE id=$1',
      [body.id],
    );
    expect(binding).toEqual({
      projectId,
      workflowId: body.workflowId,
      schedule: 'disabled',
      jobId: null,
    });
    const [workflow] = await app.dataSource.query(
      'SELECT name,content,"filePath","workspaceId","isCanEdit","isCanDelete" FROM workflows WHERE id=$1',
      [body.workflowId],
    );
    expect(workflow).toEqual({
      name: 'Project scan',
      content: { name: 'Project scan', jobs },
      filePath: expect.stringMatching('^project-' + projectId + '-.*[.]yaml$'),
      workspaceId: owner.workspace.id,
      isCanEdit: true,
      isCanDelete: true,
    });
    expect(
      await app.dataSource.query(
        'SELECT content FROM workflows WHERE "filePath"=$1',
        [template],
      ),
    ).toEqual([{ content: source }]);
    expect(
      await app.dataSource.query(
        'SELECT id FROM job_histories WHERE "workflowId"=$1',
        [body.workflowId],
      ),
    ).toEqual([]);
  });

  it('requires write access and accepts the existing group.write alias', async () => {
    await request(app.server).post(url()).send({ template }).expect(401);
    const headers = { ...other.headers, 'X-Workspace-Id': owner.workspace.id };
    await post({ template }, undefined, headers).expect(403);
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['group.write'], role],
    );
    const { body } = await post({ template }, undefined, headers).expect(201);
    expect(body.name).toBe(source.name);
  });

  it('rejects foreign projects, foreign templates and editable workflows', async () => {
    await post({ template }, foreignId).expect(404);
    for (const filePath of ['foreign-' + template, 'editable-' + template]) {
      await post({ template: filePath }).expect(404);
    }
  });

  it('renames an owned workflow atomically while preserving its pipeline and binding', async () => {
    const { body: created } = await post({ template }).expect(201);
    const rename = (name: string) =>
      request(app.server)
        .patch(url() + '/' + created.id)
        .set(owner.headers)
        .send({ name });
    const { body } = await rename('  Renamed scan  ').expect(200);
    expect(body).toMatchObject({
      id: created.id,
      schedule: 'disabled',
      workflow: {
        id: created.workflowId,
        name: 'Renamed scan',
        content: { name: 'Renamed scan', jobs },
      },
    });
    const [saved] = await app.dataSource.query(
      'SELECT name,content FROM workflows WHERE id=$1',
      [created.workflowId],
    );
    expect(saved.content).toEqual({ name: saved.name, jobs });
    expect(
      await app.dataSource.query(
        'SELECT content FROM workflows WHERE "filePath"=$1',
        [template],
      ),
    ).toEqual([{ content: source }]);
  });

  it('lets a run acquire its binding lock while rename waits on the workflow', async () => {
    const { body: created } = await post({ template }).expect(201);
    const runner = app.dataSource.createQueryRunner();
    await runner.startTransaction();
    let renaming: Promise<request.Response> | undefined;
    try {
      await runner.query('SELECT id FROM workflows WHERE id=$1 FOR KEY SHARE', [
        created.workflowId,
      ]);
      renaming = request(app.server)
        .patch(url() + '/' + created.id)
        .set(owner.headers)
        .send({ name: 'Concurrent run' })
        .expect(200)
        .then((response) => response);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const rows = await app.dataSource.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
           AND query LIKE '%workflow%' AND query LIKE '%FOR UPDATE%'`,
        );
        waiting = rows.length > 0;
        if (!waiting) await setTimeout(20);
      }
      expect(waiting).toBe(true);
      await runner.query(`SET LOCAL lock_timeout='1s'`);
      await runner.query(
        'SELECT id FROM project_workflows WHERE id=$1 FOR KEY SHARE',
        [created.id],
      );
      await runner.commitTransaction();
      await renaming;
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await renaming;
    }
  });

  it('rolls back both names when saving fails after the write', async () => {
    const { body: created } = await post({ template }).expect(201);
    const original = EntityManager.prototype.save;
    const save = jest
      .spyOn(EntityManager.prototype, 'save')
      .mockImplementation(async function (...args) {
        const saved: unknown = await original.apply(this, args);
        if (args[0] === Workflow) throw new Error('Simulated save failure');
        return saved;
      });
    try {
      await request(app.server)
        .patch(url() + '/' + created.id)
        .set(owner.headers)
        .send({ name: 'Rollback' })
        .expect(500);
    } finally {
      save.mockRestore();
    }
    const [saved] = await app.dataSource.query(
      'SELECT name,content FROM workflows WHERE id=$1',
      [created.workflowId],
    );
    expect(saved).toEqual({
      name: source.name,
      content: { name: source.name, jobs },
    });
  });

  it('validates rename input and enforces workspace and project ownership', async () => {
    const { body: created } = await post({ template }).expect(201);
    const path = url() + '/' + created.id;
    for (const payload of [
      {},
      { name: null },
      { name: '   ' },
      { name: 1 },
      { name: 'x'.repeat(121) },
      { name: 'bad\u0000name' },
    ]) {
      await request(app.server)
        .patch(path)
        .set(owner.headers)
        .send(payload)
        .expect(400);
    }
    await app.dataSource.query(
      'UPDATE workflows SET "isCanEdit"=false WHERE id=$1',
      [created.workflowId],
    );
    await request(app.server)
      .patch(path)
      .set(owner.headers)
      .send({ name: 'Denied' })
      .expect(400);
    await app.dataSource.query(
      'UPDATE workflows SET "isCanEdit"=true WHERE id=$1',
      [created.workflowId],
    );
    for (const location of [
      url(foreignId) + '/' + created.id,
      url() + '/' + randomUUID(),
    ]) {
      await request(app.server)
        .patch(location)
        .set(owner.headers)
        .send({ name: 'Denied' })
        .expect(404);
    }
    await request(app.server)
      .patch(url() + '/invalid')
      .set(owner.headers)
      .send({ name: 'Denied' })
      .expect(400);
    await app.dataSource.query(
      'UPDATE workflows SET "filePath"=$1 WHERE id=$2',
      ['shared-' + randomUUID(), created.workflowId],
    );
    await request(app.server)
      .patch(path)
      .set(owner.headers)
      .send({ name: 'Denied' })
      .expect(400);
    const [saved] = await app.dataSource.query(
      'SELECT name FROM workflows WHERE id=$1',
      [created.workflowId],
    );
    expect(saved.name).toBe(source.name);
    const [foreign] = await app.dataSource.query(
      'SELECT id FROM workflows WHERE "workspaceId"=$1 AND "filePath"=$2',
      [other.workspace.id, 'foreign-' + template],
    );
    await app.dataSource.query(
      'UPDATE project_workflows SET "workflowId"=$1 WHERE id=$2',
      [foreign.id, created.id],
    );
    await request(app.server)
      .patch(path)
      .set(owner.headers)
      .send({ name: 'Denied' })
      .expect(404);
  });

  it('requires project write access for rename and accepts the group alias', async () => {
    const { body: created } = await post({ template }).expect(201);
    const path = url() + '/' + created.id;
    await request(app.server).patch(path).send({ name: 'Denied' }).expect(401);
    const headers = { ...other.headers, 'X-Workspace-Id': owner.workspace.id };
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['project.read'], role],
    );
    await request(app.server)
      .patch(path)
      .set(headers)
      .send({ name: 'Denied' })
      .expect(403);
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['group.write'], role],
    );
    await request(app.server)
      .patch(path)
      .set(headers)
      .send({ name: 'Alias rename' })
      .expect(200);
  });

  it('rejects malformed input and archived projects', async () => {
    for (const payload of [
      {},
      { template: '   ' },
      { template: 'invalid\u0000.yaml' },
      { template, name: 'invalid\u0000name' },
      { template, name: null },
      { template, name: ' '.repeat(121) },
    ]) {
      await post(payload).expect(400);
    }
    await post({ template }, 'invalid').expect(400);
    const { body: editable } = await post({ template }).expect(201);
    await app.dataSource.query(
      'UPDATE projects SET "archivedAt"=NOW() WHERE id=$1',
      [projectId],
    );
    await post({ template }).expect(400);
    await request(app.server)
      .patch(url() + '/' + editable.id)
      .set(owner.headers)
      .send({ name: 'Archived rename' })
      .expect(400);
  });
});
