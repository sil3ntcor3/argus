import { dataSourceOptions } from '@/database/database-config';
import { JobHistory } from '@/modules/jobs-registry/entities/job-history.entity';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

describe('Project trigger run provenance (Docker Postgres)', () => {
  const db = new DataSource({ ...dataSourceOptions, cache: false });
  const workspace = randomUUID(),
    project = randomUUID(),
    workflow = randomUUID(),
    binding = randomUUID(),
    trigger = randomUUID();
  beforeAll(async () => {
    await db.initialize();
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      workspace,
      'Trigger provenance fixture',
    ]);
    await db.query(
      'INSERT INTO projects(id,name,"workspaceId") VALUES($1,$2,$3)',
      [project, 'Trigger project', workspace],
    );
    await db.query(
      'INSERT INTO workflows(id,name,content,"filePath","workspaceId") VALUES($1,$2,$3,$4,$5)',
      [
        workflow,
        'Trigger workflow',
        '{}',
        `project-${project}.yaml`,
        workspace,
      ],
    );
    await db.query(
      'INSERT INTO project_workflows(id,"projectId","workflowId") VALUES($1,$2,$3)',
      [binding, project, workflow],
    );
    await db.query(
      'INSERT INTO project_workflow_triggers(id,"projectWorkflowId",type,cron,enabled) VALUES($1,$2,$3,$4,false)',
      [trigger, binding, 'cron', '0 8 * * *'],
    );
  });
  afterAll(async () => {
    if (db.isInitialized) {
      await db.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
      await db.destroy();
    }
  });
  it('keeps legacy runs unattributed with a zero depth default and no public fields', async () => {
    const [row] = await db.query(
      'INSERT INTO job_histories("workflowId") VALUES($1) RETURNING *',
      [workflow],
    );
    expect(row).toMatchObject({
      triggerId: null,
      causedByRunId: null,
      chainDepth: 0,
    });
    const read = await db
      .getRepository(JobHistory)
      .findOneByOrFail({ id: row.id });
    for (const field of ['triggerId', 'causedByRunId', 'chainDepth'])
      expect(JSON.parse(JSON.stringify(read))).not.toHaveProperty(field);
  });
  it('preserves historical runs when the trigger or causal run is deleted', async () => {
    const [cause] = await db.query(
      'INSERT INTO job_histories("workflowId") VALUES($1) RETURNING id',
      [workflow],
    );
    const [run] = await db.query(
      'INSERT INTO job_histories("workflowId","triggerId","causedByRunId","chainDepth") VALUES($1,$2,$3,2) RETURNING id',
      [workflow, trigger, cause.id],
    );
    await db.query('DELETE FROM project_workflow_triggers WHERE id=$1', [
      trigger,
    ]);
    await db.query('DELETE FROM job_histories WHERE id=$1', [cause.id]);
    const [retained] = await db.query(
      'SELECT "triggerId","causedByRunId","chainDepth" FROM job_histories WHERE id=$1',
      [run.id],
    );
    expect(retained).toEqual({
      triggerId: null,
      causedByRunId: null,
      chainDepth: 2,
    });
  });
});
