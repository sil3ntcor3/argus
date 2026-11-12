import { dataSourceOptions } from '@/database/database-config';
import type { ProjectWorkflowTrigger } from '@/modules/projects/entities/project-workflow-trigger.entity';
import { ProjectTriggerDefinitionService } from '@/modules/projects/project-trigger-definition.service';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';

describe('Private project workflow trigger storage (e2e)', () => {
  const db = new DataSource({ ...dataSourceOptions, cache: false });
  const workspaces: string[] = [];
  beforeAll(async () => {
    await db.initialize();
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });
  afterEach(async () => {
    await db.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [
      workspaces.splice(0),
    ]);
  });

  async function parent() {
    const workspaceId = randomUUID(),
      projectId = randomUUID(),
      workflowId = randomUUID(),
      bindingId = randomUUID();
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      workspaceId,
      'Trigger storage fixture',
    ]);
    workspaces.push(workspaceId);
    await db.query(
      'INSERT INTO projects(id,name,"workspaceId") VALUES($1,$2,$3)',
      [projectId, 'Trigger project', workspaceId],
    );
    const content = {
      name: 'Legacy schedule',
      jobs: { scan: { run: 'httpx' } },
      on: { schedule: '0 6 * * *' },
    };
    await db.query(
      'INSERT INTO workflows(id,name,content,"filePath","workspaceId") VALUES($1,$2,$3,$4,$5)',
      [
        workflowId,
        content.name,
        JSON.stringify(content),
        'project-' + projectId + '-' + randomUUID() + '.yaml',
        workspaceId,
      ],
    );
    await db.query(
      'INSERT INTO project_workflows(id,"projectId","workflowId",schedule,"jobId") VALUES($1,$2,$3,$4,$5)',
      [bindingId, projectId, workflowId, '0 6 * * *', 'legacy-scheduler'],
    );
    return { workspaceId, projectId, workflowId, bindingId, content };
  }

  const writer = new ProjectTriggerDefinitionService(db);
  const insert = async (id: string, type = 'event') =>
    (
      await db.query<ProjectWorkflowTrigger[]>(
        'INSERT INTO project_workflow_triggers("projectWorkflowId",type) VALUES($1,$2) RETURNING *',
        [id, type],
      )
    )[0];

  it('atomically stores disabled definitions without touching legacy binding state or jobs', async () => {
    const owner = await parent();
    const before = await db.query(
      'SELECT * FROM project_workflows WHERE id=$1',
      [owner.bindingId],
    );
    const trigger = await writer.createDisabled(
      owner.projectId.toUpperCase(),
      owner.workspaceId,
      owner.bindingId,
      { 'project.assets.added': true },
    );
    expect(trigger).toMatchObject({
      enabled: false,
      schedulerId: null,
      lastFiredAt: null,
      config: { maxAssets: 200 },
    });
    expect(
      await db.query('SELECT * FROM project_workflows WHERE id=$1', [
        owner.bindingId,
      ]),
    ).toEqual(before);
    const [workflow] = await db.query(
      'SELECT content FROM workflows WHERE id=$1',
      [owner.workflowId],
    );
    expect(workflow.content).toEqual({
      ...owner.content,
      on: { ...owner.content.on, 'project.assets.added': trigger.config },
    });
    expect(
      await db.query('SELECT id FROM job_histories WHERE "workflowId"=$1', [
        owner.workflowId,
      ]),
    ).toEqual([]);
  });

  it('serializes duplicate creates and retains both distinct schedules', async () => {
    const o = await parent();
    const add = (cron: string) =>
      writer.createDisabled(o.projectId, o.workspaceId, o.bindingId, {
        schedule: cron,
      });
    const results = await Promise.allSettled([
      add('0 8 * * *'),
      add(' 0  8 * * * '),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 400 }),
      }),
    ]);
    await add('0 9 * * *');
    const [row] = await db.query('SELECT content FROM workflows WHERE id=$1', [
      o.workflowId,
    ]);
    expect(row.content.on.schedule).toEqual([
      { cron: '0 6 * * *' },
      { cron: '0 8 * * *' },
      { cron: '0 9 * * *' },
    ]);
    expect(
      await db.query(
        'SELECT enabled FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [o.bindingId],
      ),
    ).toEqual([{ enabled: false }, { enabled: false }]);
  });

  it('rolls back the workflow edit when trigger-row persistence fails', async () => {
    const o = await parent();
    const createRunner: () => QueryRunner = db.createQueryRunner.bind(db);
    const runnerSpy = jest
      .spyOn(db, 'createQueryRunner')
      .mockImplementation(() => {
        const runner = createRunner();
        const query = runner.query.bind(runner);
        jest
          .spyOn(runner, 'query')
          .mockImplementation(
            (sql: string, parameters?: unknown[], structured?: boolean) => {
              if (sql.startsWith('INSERT INTO "project_workflow_triggers"'))
                return Promise.reject(new Error('fixture storage failure'));
              return query(sql, parameters, structured) as Promise<unknown>;
            },
          );
        return runner;
      });
    try {
      await expect(
        writer.createDisabled(o.projectId, o.workspaceId, o.bindingId, {
          'project.assets.added': true,
        }),
      ).rejects.toThrow('fixture storage failure');
    } finally {
      runnerSpy.mockRestore();
    }
    expect(
      (
        await db.query('SELECT content FROM workflows WHERE id=$1', [
          o.workflowId,
        ])
      )[0].content,
    ).toEqual(o.content);
    expect(
      await db.query(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [o.bindingId],
      ),
    ).toEqual([]);
  });

  it('rejects cross-workspace, foreign binding, archived and read-only writes', async () => {
    const o = await parent(),
      other = await parent();
    const add = (workspace = o.workspaceId, binding = o.bindingId) =>
      writer.createDisabled(o.projectId, workspace, binding, {
        'project.assets.added': true,
      });
    await expect(
      writer.createDisabled(o.projectId, o.workspaceId, o.bindingId, {
        'project.run.completed': { workflows: ['Recon\0'] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(add(other.workspaceId)).rejects.toMatchObject({ status: 404 });
    await expect(add(o.workspaceId, other.bindingId)).rejects.toMatchObject({
      status: 404,
    });
    await db.query('UPDATE projects SET "archivedAt"=now() WHERE id=$1', [
      o.projectId,
    ]);
    await expect(add()).rejects.toMatchObject({ status: 400 });
    await db.query('UPDATE projects SET "archivedAt"=NULL WHERE id=$1', [
      o.projectId,
    ]);
    await db.query('UPDATE workflows SET "isCanEdit"=false WHERE id=$1', [
      o.workflowId,
    ]);
    await expect(add()).rejects.toMatchObject({ status: 400 });
    expect(
      await db.query(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [o.bindingId],
      ),
    ).toEqual([]);
  });

  it('stores independent trigger settings with defaults without changing legacy schedules', async () => {
    const owner = await parent();
    const before = await db.query(
      'SELECT * FROM project_workflows WHERE id=$1',
      [owner.bindingId],
    );
    expect(
      await db.query(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [owner.bindingId],
      ),
    ).toEqual([]);
    const event = await insert(owner.bindingId);
    expect(event).toMatchObject({
      id: expect.any(String),
      projectWorkflowId: owner.bindingId,
      type: 'event',
      cron: null,
      event: null,
      config: {},
      enabled: true,
      lastFiredAt: null,
      schedulerId: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const cron = await insert(owner.bindingId, 'cron');
    const fired = new Date('2026-11-11T00:00:00.123Z');
    const config = { windowMinutes: 5, maxAssets: 50, severity: ['critical'] };
    await db.query(
      'UPDATE project_workflow_triggers SET cron=$1,"schedulerId"=$2,enabled=false,"lastFiredAt"=$3 WHERE id=$4',
      ['0 8 * * *', 'private-scheduler', fired, cron.id],
    );
    await db.query(
      'UPDATE project_workflow_triggers SET event=$1,config=$2 WHERE id=$3',
      ['project.assets.added', JSON.stringify(config), event.id],
    );
    expect(
      (
        await db.query('SELECT * FROM project_workflow_triggers WHERE id=$1', [
          event.id,
        ])
      )[0],
    ).toMatchObject({ event: 'project.assets.added', config });
    expect(
      (
        await db.query('SELECT * FROM project_workflow_triggers WHERE id=$1', [
          cron.id,
        ])
      )[0],
    ).toMatchObject({
      cron: '0 8 * * *',
      schedulerId: 'private-scheduler',
      enabled: false,
      lastFiredAt: fired,
    });
    expect(
      await db.query('SELECT * FROM project_workflows WHERE id=$1', [
        owner.bindingId,
      ]),
    ).toEqual(before);
    expect(
      (
        await db.query('SELECT content FROM workflows WHERE id=$1', [
          owner.workflowId,
        ])
      )[0].content,
    ).toEqual(owner.content);
    expect(
      await db.query('SELECT id FROM job_histories WHERE "workflowId"=$1', [
        owner.workflowId,
      ]),
    ).toEqual([]);
  });

  it('rejects missing bindings and cleans only affected triggers when a binding or workflow is deleted', async () => {
    const first = await parent(),
      second = await parent();
    await expect(insert(randomUUID())).rejects.toMatchObject({ code: '23503' });
    await insert(first.bindingId);
    const survivor = await insert(second.bindingId);
    await db.query('DELETE FROM project_workflows WHERE id=$1', [
      first.bindingId,
    ]);
    expect(
      await db.query(
        'SELECT id FROM project_workflow_triggers WHERE "projectWorkflowId"=$1',
        [first.bindingId],
      ),
    ).toEqual([]);
    expect(
      await db.query('SELECT id FROM project_workflow_triggers WHERE id=$1', [
        survivor.id,
      ]),
    ).toEqual([{ id: survivor.id }]);
    await db.query('DELETE FROM workflows WHERE id=$1', [second.workflowId]);
    expect(
      await db.query('SELECT id FROM project_workflow_triggers WHERE id=$1', [
        survivor.id,
      ]),
    ).toEqual([]);
  });

  it('follows project and workspace deletion without removing another workspace settings', async () => {
    const first = await parent(),
      second = await parent();
    const removed = await insert(first.bindingId),
      survivor = await insert(second.bindingId);
    await db.query('DELETE FROM projects WHERE id=$1', [first.projectId]);
    expect(
      await db.query('SELECT id FROM project_workflow_triggers WHERE id=$1', [
        removed.id,
      ]),
    ).toEqual([]);
    expect(
      await db.query('SELECT id FROM project_workflow_triggers WHERE id=$1', [
        survivor.id,
      ]),
    ).toEqual([{ id: survivor.id }]);
    await db.query('DELETE FROM workspaces WHERE id=$1', [second.workspaceId]);
    expect(
      await db.query('SELECT id FROM project_workflow_triggers WHERE id=$1', [
        survivor.id,
      ]),
    ).toEqual([]);
  });
});
