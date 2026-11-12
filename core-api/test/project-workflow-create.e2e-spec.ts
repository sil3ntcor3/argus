import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { DataSource, EntityManager } from 'typeorm';
import { dataSourceOptions } from '@/database/database-config';
import { WorkflowsService } from '@/modules/workflows/workflows.service';
import { Tool } from '@/modules/tools/entities/tools.entity';
import { ConnectorRegistryService } from '@/modules/connectors/connector-registry.service';
import { decryptInlineConfig } from '@/modules/tools/validators/tool-config-profiles.crypto';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { ProjectTriggerDefinitionService } from '@/modules/projects/project-trigger-definition.service';
import { Workflow, type WorkflowContent } from '@/modules/workflows/entities/workflow.entity';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
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

  describe('Generic saves with project triggers', () => {
    const writer = () => new ProjectTriggerDefinitionService(app.dataSource);
    async function triggerFixture(managed = true) {
      const { body } = await post({ jobs: { probe: { run: 'httpx' } } }).expect(
        201,
      );
      const content = {
        name: body.name as string,
        jobs: { probe: { run: 'httpx' } },
        on: { target: ['domain'], schedule: '0 6 * * *' },
      };
      await app.dataSource.query('UPDATE workflows SET content=$1 WHERE id=$2', [
        JSON.stringify(content),
        body.workflowId,
      ]);
      if (managed) {
        await writer().createDisabled(projectId, owner.workspace.id, body.id, {
          schedule: '0 8 * * *',
        });
        await writer().createDisabled(projectId, owner.workspace.id, body.id, {
          'project.assets.added': { maxAssets: 7 },
        });
      }
      const [saved] = await app.dataSource.query<{ content: WorkflowContent }[]>(
        'SELECT content FROM workflows WHERE id=$1',
        [body.workflowId],
      );
      return {
        binding: body.id as string,
        workflow: body.workflowId as string,
        content: saved.content,
      };
    }
    const genericSave = (id: string, content: object, headers = owner.headers) =>
      request(app.server)
        .patch('/api/workflows/' + id)
        .set(headers)
        .send({ content });
    it.each([false, true])(
      'preserves the complete managed block when omitted=%s',
      async (omit) => {
        const f = await triggerFixture();
        const content = {
          ...f.content,
          jobs: { probe: { run: 'httpx', allowFailure: false } },
        };
        if (omit) {
          await request(app.server)
            .patch('/api/workflows/' + f.workflow)
            .set(owner.headers)
            .send({ filePath: randomUUID() + '.yaml' })
            .expect(200);
          delete content.on;
        }
        const { body } = await genericSave(f.workflow, content).expect(200);
        expect(body.content).toEqual({ jobs: content.jobs, on: f.content.on });
        expect(
          (
            await app.dataSource.query(
              'SELECT content FROM workflows WHERE id=$1',
              [f.workflow],
            )
          )[0].content,
        ).toEqual(body.content);
        expect(
          await app.dataSource.query(
            'SELECT enabled FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
            [f.binding],
          ),
        ).toEqual([{ enabled: false }, { enabled: false }]);
        await genericSave(f.workflow, content, {
          ...other.headers,
          'X-Workspace-Id': owner.workspace.id,
        }).expect(403);
      },
    );
    it('validates with the transaction connection when the pool has one slot', async () => {
      const f = await triggerFixture();
      const db = new DataSource({
        ...dataSourceOptions,
        cache: false,
        migrationsRun: false,
        synchronize: false,
        installExtensions: false,
        extra: { max: 1, connectionTimeoutMillis: 500 },
      });
      await db.initialize();
      try {
        const service = new WorkflowsService(
          db.getRepository(Workflow),
          db.getRepository(Tool),
        );
        const saved = await service.updateWorkflow(
          f.workflow,
          {
            content: {
              ...f.content,
              jobs: { probe: { run: 'httpx', allowFailure: false } },
            },
          },
          { id: owner.workspace.id },
        );
        expect(saved.content.on).toEqual(f.content.on);
      } finally {
        await db.destroy();
      }
    });
    it('keeps ordinary workflow schedule edits working', async () => {
      const f = await triggerFixture(false);
      const content = { ...f.content, on: { schedule: '0 9 * * *' } };
      expect(
        (await genericSave(f.workflow, content).expect(200)).body.content,
      ).toEqual({ jobs: content.jobs, on: content.on });
    });
    it('rolls back a failed generic save after its write', async () => {
      const f = await triggerFixture();
      const original = EntityManager.prototype.save;
      const save = jest
        .spyOn(EntityManager.prototype, 'save')
        .mockImplementation(async function (...args) {
          const saved: unknown = await original.apply(this, args);
          if (args[0] === Workflow)
            throw new Error('Fixture generic save failure');
          return saved;
        });
      try {
        await genericSave(f.workflow, {
          ...f.content,
          name: 'Rollback',
          jobs: { probe: { run: 'httpx', allowFailure: false } },
        }).expect(500);
      } finally {
        save.mockRestore();
      }
      expect(
        (
          await app.dataSource.query(
            'SELECT content FROM workflows WHERE id=$1',
            [f.workflow],
          )
        )[0].content,
      ).toEqual(f.content);
    });
    it('retains a concurrently-created definition when a stale generic save follows it', async () => {
      const f = await triggerFixture(false),
        blocker = app.dataSource.createQueryRunner();
      await blocker.startTransaction();
      const [{ pid }] = await blocker.query<{ pid: number }[]>(
        'SELECT pg_backend_pid() AS pid',
      );
      const waitFor = async (count: number) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [{ n }] = await app.dataSource.query<{ n: number }[]>(
            `WITH RECURSIVE waiters(pid) AS (
            SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid))
          ) SELECT (count(*)-1)::int AS n FROM waiters`,
            [pid],
          );
          if (n >= count) return;
          await setTimeout(20);
        }
        throw new Error('Expected workflow writers to wait on fixture lock');
      };
      let creating: Promise<unknown> | undefined,
        saving: Promise<request.Response> | undefined;
      try {
        await blocker.query('SELECT id FROM workflows WHERE id=$1 FOR UPDATE', [
          f.workflow,
        ]);
        creating = writer().createDisabled(
          projectId,
          owner.workspace.id,
          f.binding,
          { 'project.assets.added': true },
        );
        await waitFor(1);
        saving = genericSave(f.workflow, {
          ...f.content,
          jobs: { probe: { run: 'httpx', allowFailure: false } },
        }).then((r) => r);
        await waitFor(2);
      } finally {
        await blocker.rollbackTransaction();
        await blocker.release();
        await Promise.allSettled([creating, saving]);
      }
      await creating;
      expect((await saving)?.status).toBe(200);
      const [saved] = await app.dataSource.query(
        'SELECT content FROM workflows WHERE id=$1',
        [f.workflow],
      );
      expect(saved.content).toMatchObject({
        jobs: { probe: { allowFailure: false } },
        on: { target: ['domain'], 'project.assets.added': { maxAssets: 200 } },
      });
    });
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
    await post(
      { jobs: { probe: { run: 'httpx' } } },
      undefined,
      headers,
    ).expect(403);
    await post(
      { copyFromProjectWorkflowId: randomUUID() },
      undefined,
      headers,
    ).expect(403);
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['group.write'], role],
    );
    const { body } = await post({ template }, undefined, headers).expect(201);
    expect(body.name).toBe(source.name);
  });

  it('creates a selected DAG without a template, preserving IDs and disabled scheduling', async () => {
    const pipeline = {
      ports: { run: 'naabu', input: ['host'] },
      web: { run: 'httpx', needs: ['ports'] },
    };
    const { body } = await post(
      { jobs: pipeline },
      projectId.toUpperCase(),
    ).expect(201);
    expect(body).toEqual({
      id: expect.any(String),
      workflowId: expect.any(String),
      name: 'Project workflow',
      schedule: 'disabled',
    });
    const [saved] = await app.dataSource.query(
      'SELECT w.name,w.content,w."workspaceId",pw."projectId",pw.schedule,pw."jobId" FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw.id=$1',
      [body.id],
    );
    expect(saved).toEqual({
      name: body.name,
      content: { name: body.name, jobs: pipeline },
      workspaceId: owner.workspace.id,
      projectId,
      schedule: 'disabled',
      jobId: null,
    });
    await post({ jobs: pipeline }, foreignId).expect(404);
    expect(
      (await post({ jobs: pipeline, name: '  Selected tools  ' }).expect(201))
        .body.name,
    ).toBe('Selected tools');
  });

  it('rejects invalid source combinations and graphs without writing workflows or bindings', async () => {
    const before = await app.dataSource.query(
      'SELECT id FROM workflows WHERE "workspaceId"=$1 ORDER BY id',
      [owner.workspace.id],
    );
    for (const payload of [
      {},
      { template, jobs },
      { template: null },
      { jobs: null },
      { jobs: [] },
      { jobs: {} },
      { jobs: { p: { run: 'httpx', needs: ['missing'] } } },
      { jobs: { p: { run: 'httpx', input: ['repo'] } } },
      {
        jobs: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => ['j' + i, { run: 'httpx' }]),
        ),
      },
    ])
      await post(payload).expect(400);
    await post({ jobs: { p: { run: randomUUID() } } }).expect(404);
    expect(
      await app.dataSource.query(
        'SELECT id FROM workflows WHERE "workspaceId"=$1 ORDER BY id',
        [owner.workspace.id],
      ),
    ).toEqual(before);
  });

  it('copies another project binding including an archived source, without scheduling or mutating it', async () => {
    const { body: sourceBinding } = await post({ template }).expect(201);
    const { body: destination } = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name: 'Copy destination' })
      .expect(201);
    const content = { ...source, instructions: 'Do not copy this metadata' };
    await app.dataSource.query('UPDATE workflows SET content=$1 WHERE id=$2', [
      JSON.stringify(content),
      sourceBinding.workflowId,
    ]);
    await app.dataSource.query(
      'UPDATE project_workflows SET schedule=$1,"jobId"=$2 WHERE id=$3',
      ['0 6 * * *', 'source-schedule', sourceBinding.id],
    );
    await app.dataSource.query(
      'UPDATE projects SET "archivedAt"=NOW() WHERE id=$1',
      [projectId],
    );
    try {
      const { body } = await post(
        { copyFromProjectWorkflowId: sourceBinding.id },
        destination.id,
      ).expect(201);
      expect(body).toEqual({
        id: expect.any(String),
        workflowId: expect.any(String),
        name: source.name + ' (copy)',
        schedule: 'disabled',
      });
      expect(body.workflowId).not.toBe(sourceBinding.workflowId);
      const [copy] = await app.dataSource.query(
        'SELECT w.content,w."workspaceId",w."filePath",pw."projectId",pw.schedule,pw."jobId" FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw.id=$1',
        [body.id],
      );
      expect(copy).toEqual({
        content: { name: body.name, jobs },
        workspaceId: owner.workspace.id,
        filePath: expect.stringMatching('^project-' + destination.id + '-'),
        projectId: destination.id,
        schedule: 'disabled',
        jobId: null,
      });
      expect(
        (
          await post(
            {
              copyFromProjectWorkflowId: sourceBinding.id,
              name: '  Named copy  ',
            },
            destination.id.toUpperCase(),
          ).expect(201)
        ).body.name,
      ).toBe('Named copy');
      expect(
        (
          await app.dataSource.query(
            'SELECT content FROM workflows WHERE id=$1',
            [sourceBinding.workflowId],
          )
        )[0].content,
      ).toEqual(content);
      expect(
        (
          await app.dataSource.query(
            'SELECT schedule,"jobId" FROM project_workflows WHERE id=$1',
            [sourceBinding.id],
          )
        )[0],
      ).toEqual({ schedule: '0 6 * * *', jobId: 'source-schedule' });
    } finally {
      await app.dataSource.query(
        'UPDATE projects SET "archivedAt"=NULL WHERE id=$1',
        [projectId],
      );
    }
  });

  it('requires a valid copy source whose project and workflow both belong to the workspace', async () => {
    const { body: sourceBinding } = await post({ template }).expect(201);
    const { body: foreign } = await post(
      { template: 'foreign-' + template },
      foreignId,
      other.headers,
    ).expect(201);
    for (const payload of [
      { copyFromProjectWorkflowId: null },
      { copyFromProjectWorkflowId: 'invalid' },
      { template, copyFromProjectWorkflowId: sourceBinding.id },
      { jobs, copyFromProjectWorkflowId: sourceBinding.id },
      { template, jobs, copyFromProjectWorkflowId: sourceBinding.id },
    ])
      await post(payload).expect(400);
    for (const id of [randomUUID(), foreign.id, sourceBinding.workflowId])
      await post({ copyFromProjectWorkflowId: id }).expect(404);
    await app.dataSource.query('UPDATE workflows SET content=$1 WHERE id=$2', [
      JSON.stringify({ jobs: { a: { run: 'httpx', needs: ['missing'] } } }),
      sourceBinding.workflowId,
    ]);
    await post({ copyFromProjectWorkflowId: sourceBinding.id }).expect(400);
    await app.dataSource.query(
      'UPDATE project_workflows SET "workflowId"=$1 WHERE id=$2',
      [foreign.workflowId, sourceBinding.id],
    );
    await post({ copyFromProjectWorkflowId: sourceBinding.id }).expect(404);
  });

  it('rolls back selected-job creation when saving the binding fails', async () => {
    const name = 'Rollback creation ' + randomUUID();
    const original = EntityManager.prototype.save;
    const save = jest
      .spyOn(EntityManager.prototype, 'save')
      .mockImplementation(async function (this: EntityManager, ...args) {
        const result: unknown = await original.apply(this, args);
        if (args[0] === AssetGroupWorkflow)
          throw new Error('Simulated binding failure');
        return result;
      });
    try {
      await post({ name, jobs: { p: { run: 'httpx' } } }).expect(500);
    } finally {
      save.mockRestore();
    }
    expect(
      await app.dataSource.query(
        'SELECT id FROM workflows WHERE name=$1 AND "workspaceId"=$2',
        [name, owner.workspace.id],
      ),
    ).toEqual([]);
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

  it('replaces a named DAG while retaining scheduling and authored content', async () => {
    const { body: created } = await post({ template }).expect(201);
    const content = {
      name: source.name,
      jobs,
      on: { schedule: '0 5 * * *' },
      instructions: 'Keep me',
    };
    await app.dataSource.query('UPDATE workflows SET content=$1 WHERE id=$2', [
      JSON.stringify(content),
      created.workflowId,
    ]);
    const pipeline = {
      ports: { run: 'naabu', input: ['host'], allowFailure: false },
      web: { run: 'httpx', needs: ['ports'] },
    };
    const { body } = await request(app.server)
      .patch(url(projectId.toUpperCase()) + '/' + created.id)
      .set(owner.headers)
      .send({ jobs: pipeline })
      .expect(200);
    expect(body.workflow.content).toEqual({ ...content, jobs: pipeline });
    expect(body.workflow.name).toBe(source.name);
    expect(body.schedule).toBe('disabled');
  });

  it('rejects invalid graphs and leaves the prior name and pipeline intact', async () => {
    const { body: created } = await post({ template }).expect(201);
    const patch = (pipeline: unknown, status = 400) =>
      request(app.server)
        .patch(url() + '/' + created.id)
        .set(owner.headers)
        .send({ name: 'Must roll back', jobs: pipeline })
        .expect(status);
    for (const pipeline of [
      null,
      {},
      { p: { run: 'httpx', needs: ['missing'] } },
      { p: { run: 'httpx', input: ['repo'] } },
      { ' __proto__ ': { run: 'httpx' } },
      { ' toString ': { run: 'httpx' } },
      { p: { run: 'httpx', config: [] } },
      { p: { run: 'httpx', config: { text: '\u0000' } } },
      { p: { run: 'httpx', configProfileId: 'invalid' } },
      { a: { run: 'naabu', needs: ['b'] }, b: { run: 'httpx', needs: ['a'] } },
      Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [
          'j' + i,
          { run: 'missing-' + i },
        ]),
      ),
    ]) {
      await patch(pipeline);
    }
    await patch({ p: { run: randomUUID() } }, 404);
    const [saved] = await app.dataSource.query(
      'SELECT name,content FROM workflows WHERE id=$1',
      [created.workflowId],
    );
    expect(saved).toEqual({
      name: source.name,
      content: { name: source.name, jobs },
    });
  });

  it('encrypts connector edits, preserves echoed secrets, and scopes profiles to workspace and tool', async () => {
    const toolName = 'pipeline-' + randomUUID();
    const tool = await insert(
      'INSERT INTO tools(name,type,categories) VALUES ($1,$2,$3)',
      [
        toolName,
        'connector',
        JSON.stringify([
          {
            name: 'vulnerabilities',
            targetTypes: ['DOMAIN'],
            inputs: ['host'],
          },
        ]),
      ],
    );
    const registry = jest
      .spyOn(app.app.get(ConnectorRegistryService), 'getConnector')
      .mockReturnValue({
        configSchema: {
          required: ['apiKey'],
          properties: { apiKey: { type: 'string', 'ui:widget': 'password' } },
        },
      } as ReturnType<ConnectorRegistryService['getConnector']>);
    try {
      const { body: created } = await post({ template }).expect(201);
      const patch = (job: object, status = 200) =>
        request(app.server)
          .patch(url() + '/' + created.id)
          .set(owner.headers)
          .send({ jobs: { finding: { run: toolName, ...job } } })
          .expect(status);
      await patch({}, 400);
      await patch(
        { config: { apiKey: { value: 'Invalid secret object' } } },
        400,
      );
      const first = await patch({
        config: { apiKey: 'Local pipeline secret' },
      });
      const encrypted = first.body.workflow.content.jobs.finding.config
        .apiKey as string;
      expect(encrypted).not.toBe('Local pipeline secret');
      const dek = await app.app
        .get(WorkspaceEncryptionService)
        .getDEK(owner.workspace.id);
      expect(
        decryptInlineConfig({ apiKey: encrypted }, ['apiKey'], dek).apiKey,
      ).toBe('Local pipeline secret');
      const { body: selected } = await post({
        jobs: {
          finding: { run: toolName, config: { apiKey: 'Selected-job secret' } },
        },
      }).expect(201);
      const [stored] = await app.dataSource.query(
        'SELECT content FROM workflows WHERE id=$1',
        [selected.workflowId],
      );
      const selectedSecret = stored.content.jobs.finding.config
        .apiKey as string;
      expect(selectedSecret).not.toBe('Selected-job secret');
      expect(
        decryptInlineConfig({ apiKey: selectedSecret }, ['apiKey'], dek).apiKey,
      ).toBe('Selected-job secret');
      const { body: copied } = await post({
        copyFromProjectWorkflowId: selected.id,
      }).expect(201);
      const [copiedWorkflow] = await app.dataSource.query(
        'SELECT content FROM workflows WHERE id=$1',
        [copied.workflowId],
      );
      expect(copiedWorkflow.content.jobs.finding.config.apiKey).toBe(
        selectedSecret,
      );
      for (const apiKey of [encrypted, '****']) {
        const result = await patch({ config: { apiKey } });
        expect(result.body.workflow.content.jobs.finding.config.apiKey).toBe(
          encrypted,
        );
      }
      const foreign = await insert(
        'INSERT INTO tool_config_profiles(name,config,"workspaceId","toolId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), '{}', other.workspace.id, tool],
      );
      await patch({ configProfileId: foreign }, 404);
      await post({
        jobs: { finding: { run: toolName, configProfileId: foreign } },
      }).expect(404);
      const [builtin] = await app.dataSource.query(
        'SELECT id FROM tools WHERE name=$1',
        ['httpx'],
      );
      const wrong = await insert(
        'INSERT INTO tool_config_profiles(name,config,"workspaceId","toolId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), '{}', owner.workspace.id, builtin.id],
      );
      await patch({ configProfileId: wrong }, 404);
      const own = await insert(
        'INSERT INTO tool_config_profiles(name,config,"workspaceId","toolId") VALUES ($1,$2,$3,$4)',
        [
          randomUUID(),
          JSON.stringify({ apiKey: 'Profile secret' }),
          owner.workspace.id,
          tool,
        ],
      );
      await patch({ configProfileId: own });
      await patch({
        configProfileId: own,
        config: { target: 'partial override' },
      });
      const { body: profileCopy } = await post({
        copyFromProjectWorkflowId: created.id,
      }).expect(201);
      const [profileWorkflow] = await app.dataSource.query(
        'SELECT content FROM workflows WHERE id=$1',
        [profileCopy.workflowId],
      );
      expect(profileWorkflow.content.jobs.finding).toEqual({
        run: toolName,
        configProfileId: own,
        config: { target: 'partial override' },
      });
    } finally {
      registry.mockRestore();
      await app.dataSource.query('DELETE FROM tools WHERE id=$1', [tool]);
    }
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
    await post({ jobs: { probe: { run: 'httpx' } } }).expect(400);
    await request(app.server)
      .patch(url() + '/' + editable.id)
      .set(owner.headers)
      .send({ name: 'Archived rename' })
      .expect(400);
  });
});
