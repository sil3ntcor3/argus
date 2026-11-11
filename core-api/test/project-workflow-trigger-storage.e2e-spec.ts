import { dataSourceOptions } from '@/database/database-config';
import type { ProjectWorkflowTrigger } from '@/modules/projects/entities/project-workflow-trigger.entity';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

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

  const insert = async (id: string, type = 'event') =>
    (
      await db.query<ProjectWorkflowTrigger[]>(
        'INSERT INTO project_workflow_triggers("projectWorkflowId",type) VALUES($1,$2) RETURNING *',
        [id, type],
      )
    )[0];

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
