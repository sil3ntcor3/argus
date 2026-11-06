import { JobHistory } from '@/modules/jobs-registry/entities/job-history.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Storage constraints and privacy; new-run attribution is deliberately not enabled. */
describe('Project provenance foundation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let toolId: string;
  let workflowId: string;
  let projectId: string;
  let runId: string;
  let findingId: string;
  let linkId: string;
  const insert = async (sql: string, values: unknown[]): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'provenance-owner');
    other = await createUserWithWorkspace(app.server, 'provenance-other');
    const target = await insert(
      `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
      ['provenance.example.com', owner.workspace.id],
    );
    assetId = await insert(
      `INSERT INTO assets (value, "targetId") VALUES ($1, $2)`,
      ['provenance.example.com', target],
    );
    toolId = (
      await app.dataSource.query<{ id: string }[]>(
        `SELECT id FROM tools WHERE name = 'nuclei'`,
      )
    )[0].id;
    workflowId = await insert(
      `INSERT INTO workflows (name, content, "filePath", "workspaceId") VALUES ($1, $2, $3, $4)`,
      [
        'Provenance workflow',
        JSON.stringify({ name: 'Provenance workflow', on: {}, jobs: {} }),
        'provenance.yaml',
        owner.workspace.id,
      ],
    );
  });

  beforeEach(async () => {
    projectId = await insert(
      `INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)`,
      [randomUUID(), owner.workspace.id],
    );
    const binding = await insert(
      `INSERT INTO project_workflows ("projectId", "workflowId") VALUES ($1, $2)`,
      [projectId, workflowId],
    );
    runId = await insert(
      `INSERT INTO job_histories ("workflowId", "jobHistoryName", "projectId", "projectWorkflowId") VALUES ($1, $2, $3, $4)`,
      [workflowId, 'Provenance run', projectId, binding],
    );
    findingId = await insert(
      `INSERT INTO vulnerabilities (name, fingerprint, "assetId", "toolId", "jobHistoryId") VALUES ($1, $2, $3, $4, $5)`,
      ['Provenance finding', randomUUID(), assetId, toolId, runId],
    );
    linkId = await insert(
      `INSERT INTO project_vulnerabilities ("projectId", "vulnerabilityId", "firstSeenJobHistoryId", "lastSeenJobHistoryId") VALUES ($1, $2, $3, $3)`,
      [projectId, findingId, runId],
    );
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('keeps provenance out of default entity reads and existing API responses', async () => {
    const run = await app.dataSource
      .getRepository(JobHistory)
      .findOneByOrFail({ id: runId });
    expect(JSON.parse(JSON.stringify(run))).not.toHaveProperty('projectId');
    expect(JSON.parse(JSON.stringify(run))).not.toHaveProperty(
      'projectWorkflowId',
    );
    for (const path of [
      `/api/jobs-registry/histories/${runId}`,
      `/api/vulnerabilities/${findingId}`,
    ]) {
      const response = await request(app.server)
        .get(path)
        .set(owner.headers)
        .expect(200);
      expect(JSON.stringify(response.body)).not.toMatch(
        /"project(?:Workflow)?Id"/,
      );
      await request(app.server)
        .get(path)
        .set('X-Workspace-Id', owner.workspace.id)
        .expect(401);
      await request(app.server)
        .get(path)
        .set(other.headers)
        .set('X-Workspace-Id', owner.workspace.id)
        .expect(403);
    }
  });

  it('leaves newly created runs unattributed until runtime attribution is ported', async () => {
    const id = await insert(
      `INSERT INTO job_histories ("workflowId", "jobHistoryName") VALUES ($1, $2)`,
      [workflowId, 'New standalone run'],
    );
    const [row] = await app.dataSource.query<
      { projectId: string | null; projectWorkflowId: string | null }[]
    >(
      `SELECT "projectId", "projectWorkflowId" FROM job_histories WHERE id = $1`,
      [id],
    );
    expect(row).toEqual({ projectId: null, projectWorkflowId: null });
  });

  it('enforces one link per project/finding and valid provenance references', async () => {
    await expect(
      app.dataSource.query(
        `INSERT INTO project_vulnerabilities ("projectId", "vulnerabilityId") VALUES ($1, $2)`,
        [projectId, findingId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      app.dataSource.query(
        `UPDATE project_vulnerabilities SET "firstSeenJobHistoryId" = $1 WHERE id = $2`,
        [randomUUID(), linkId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('retains the finding and its timestamps/count when a referenced run is deleted', async () => {
    const [before] = await app.dataSource.query<Record<string, unknown>[]>(
      `SELECT "firstSeenAt", "lastSeenAt", "timesSeen" FROM project_vulnerabilities WHERE id = $1`,
      [linkId],
    );
    await app.dataSource.query('DELETE FROM job_histories WHERE id = $1', [
      runId,
    ]);
    const [after] = await app.dataSource.query<Record<string, unknown>[]>(
      `SELECT "firstSeenAt", "lastSeenAt", "timesSeen", "firstSeenJobHistoryId", "lastSeenJobHistoryId" FROM project_vulnerabilities WHERE id = $1`,
      [linkId],
    );
    expect(after).toEqual({
      ...before,
      firstSeenJobHistoryId: null,
      lastSeenJobHistoryId: null,
    });
    const [finding] = await app.dataSource.query<
      { id: string; jobHistoryId: string | null }[]
    >(`SELECT id, "jobHistoryId" FROM vulnerabilities WHERE id = $1`, [
      findingId,
    ]);
    expect(finding).toEqual({ id: findingId, jobHistoryId: null });
  });

  it('nulls run references and removes only the link when the project row is deleted', async () => {
    await app.dataSource.query('DELETE FROM projects WHERE id = $1', [
      projectId,
    ]);
    const [run] = await app.dataSource.query<Record<string, unknown>[]>(
      `SELECT "projectId", "projectWorkflowId" FROM job_histories WHERE id = $1`,
      [runId],
    );
    expect(run).toEqual({ projectId: null, projectWorkflowId: null });
    expect(
      await app.dataSource.query(
        'SELECT id FROM project_vulnerabilities WHERE id = $1',
        [linkId],
      ),
    ).toEqual([]);
    expect(
      await app.dataSource.query(
        'SELECT id FROM vulnerabilities WHERE id = $1',
        [findingId],
      ),
    ).toHaveLength(1);
  });

  it('removes the link when a finding is deleted while retaining its run and project', async () => {
    await app.dataSource.query('DELETE FROM vulnerabilities WHERE id = $1', [
      findingId,
    ]);
    expect(
      await app.dataSource.query(
        'SELECT id FROM project_vulnerabilities WHERE id = $1',
        [linkId],
      ),
    ).toEqual([]);
    expect(
      await app.dataSource.query('SELECT id FROM job_histories WHERE id = $1', [
        runId,
      ]),
    ).toHaveLength(1);
    expect(
      await app.dataSource.query('SELECT id FROM projects WHERE id = $1', [
        projectId,
      ]),
    ).toHaveLength(1);
  });
});
