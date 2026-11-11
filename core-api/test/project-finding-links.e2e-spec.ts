import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { Severity } from '@/common/enums/enum';
import { DataAdapterService } from '@/modules/data-adapter/data-adapter.service';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { Job } from '@/modules/jobs-registry/entities/job.entity';
import type { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Real transaction/constraint checks; completed jobs and findings are synthetic. */
describe('Project finding sightings (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let adapter: DataAdapterService;
  let publisher: jest.SpyInstance;
  let assetId: string;
  let foreignAssetId: string;
  let workflowId: string;
  let foreignWorkflowId: string;
  let foreignProjectId: string;
  let toolId: string;
  const projects: string[] = [];
  const insert = async (sql: string, values: unknown[]): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };
  const job = async (
    kind = 'project',
    project = 0,
    historyId?: string,
  ): Promise<Job> => {
    const runId =
      historyId ??
      (await insert(
        `INSERT INTO job_histories ("workflowId", "projectId", "isCompleted") VALUES ($1, $2, true)`,
        [
          kind === 'foreign-workflow' ? foreignWorkflowId : workflowId,
          kind === 'standalone'
            ? null
            : kind === 'foreign-project'
              ? foreignProjectId
              : projects[project],
        ],
      ));
    const id = await insert(
      `INSERT INTO jobs ("jobHistoryId", "assetId", "toolId", category, status) VALUES ($1, $2, $3, 'vulnerabilities', 'completed')`,
      [runId, kind === 'foreign-asset' ? foreignAssetId : assetId, toolId],
    );
    return app.dataSource.getRepository(Job).findOneOrFail({
      where: { id },
      relations: { jobHistory: true, asset: { target: true }, tool: true },
    });
  };
  const ingest = (source: Job, name: string) =>
    adapter.vulnerabilities({
      job: source,
      data: [{ name, severity: Severity.HIGH }] as Vulnerability[],
    });
  const finding = async (name: string): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      'SELECT id FROM vulnerabilities WHERE name = $1',
      [name],
    );
    return row.id;
  };
  const links = (id: string): Promise<Record<string, unknown>[]> =>
    app.dataSource.query(
      'SELECT * FROM project_vulnerabilities WHERE "vulnerabilityId" = $1 ORDER BY "projectId"',
      [id],
    );
  const observations = (
    id: string,
  ): Promise<{ jobHistoryId: string | null; seenAt: Date }[]> =>
    app.dataSource.query(
      `SELECT observation."jobHistoryId", observation."seenAt"
       FROM project_vulnerability_observations AS observation
       JOIN project_vulnerabilities AS link ON link.id = observation."projectVulnerabilityId"
       WHERE link."vulnerabilityId" = $1`,
      [id],
    );

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'finding-link-owner');
    other = await createUserWithWorkspace(app.server, 'finding-link-other');
    const asset = async (workspaceId: string, value: string) => {
      const targetId = await insert(
        `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
        [value, workspaceId],
      );
      return insert('INSERT INTO assets (value, "targetId") VALUES ($1, $2)', [
        value,
        targetId,
      ]);
    };
    assetId = await asset(owner.workspace.id, 'argus-finding.example.com');
    foreignAssetId = await asset(
      other.workspace.id,
      'foreign-finding.example.com',
    );
    const workflow = (workspaceId: string) =>
      insert(
        'INSERT INTO workflows (name, content, "filePath", "workspaceId") VALUES ($1, $2, $3, $4)',
        [
          'Argus finding workflow',
          JSON.stringify({ name: 'Argus finding workflow', jobs: {} }),
          randomUUID() + '.yaml',
          workspaceId,
        ],
      );
    workflowId = await workflow(owner.workspace.id);
    foreignWorkflowId = await workflow(other.workspace.id);
    for (const name of ['Argus finding A', 'Argus finding B'])
      projects.push(
        await insert(
          'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)',
          [name, owner.workspace.id],
        ),
      );
    foreignProjectId = await insert(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)',
      ['Argus foreign finding project', other.workspace.id],
    );
    toolId = (
      await app.dataSource.query<{ id: string }[]>(
        `SELECT id FROM tools WHERE name = 'nuclei'`,
      )
    )[0].id;
    adapter = app.app.get(DataAdapterService);
    publisher = jest
      .spyOn(app.app.get(EventBridgeService), 'publishSafely')
      .mockResolvedValue(undefined as never);
  });
  beforeEach(() => publisher.mockClear());
  afterAll(async () => {
    publisher?.mockRestore();
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('records initial provenance from persisted IDs hidden by default ORM reads', async () => {
    const source = await job();
    expect(JSON.parse(JSON.stringify(source.jobHistory))).not.toHaveProperty(
      'projectId',
    );
    const name = randomUUID();
    await ingest(source, name);
    const id = await finding(name);
    const rows = await links(id);
    expect(rows).toHaveLength(1);
    const [link] = rows;
    expect(link).toMatchObject({
      projectId: projects[0],
      vulnerabilityId: id,
      firstSeenJobHistoryId: source.jobHistory.id,
      lastSeenJobHistoryId: source.jobHistory.id,
      timesSeen: 1,
    });
    expect(link.firstSeenAt).toEqual(link.lastSeenAt);
    expect(await observations(id)).toEqual([
      { jobHistoryId: source.jobHistory.id, seenAt: link.firstSeenAt },
    ]);
    const response = await request(app.server)
      .get(`/api/vulnerabilities/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(JSON.stringify(response.body)).not.toMatch(
      /"project(?:Workflow)?Id"/,
    );
    const [, envelope] = publisher.mock.calls[0] as [
      unknown,
      { payload: Record<string, unknown> },
    ];
    expect(envelope.payload).not.toHaveProperty('projectId');
  });

  it('links an existing workspace finding to each project without cloning it', async () => {
    const name = randomUUID();
    await ingest(await job('standalone'), name);
    const id = await finding(name);
    expect(await links(id)).toEqual([]);
    await ingest(await job(), name);
    await ingest(await job('project', 1), name);
    expect(await finding(name)).toBe(id);
    expect((await links(id)).map((row) => row.projectId).sort()).toEqual(
      [...projects].sort(),
    );
    expect((await links(id)).map((row) => row.timesSeen)).toEqual([1, 1]);
    expect(await observations(id)).toHaveLength(2);
  });

  it('counts distinct runs once and keeps the latest sighting on A/B/A retries', async () => {
    const name = randomUUID(),
      source = await job();
    await ingest(source, name);
    const id = await finding(name),
      initial = await links(id);
    expect(initial).toHaveLength(1);
    await ingest(source, name);
    expect(await links(id)).toEqual(initial);
    const next = await job();
    await ingest(next, name);
    const later = await links(id);
    expect(later[0]).toMatchObject({
      timesSeen: 2,
      firstSeenJobHistoryId: source.jobHistory.id,
      lastSeenJobHistoryId: next.jobHistory.id,
      firstSeenAt: initial[0].firstSeenAt,
    });
    await ingest(source, name);
    await ingest(next, name);
    expect(await links(id)).toEqual(later);
    expect(await observations(id)).toHaveLength(2);
    expect(publisher).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent initial reports into one link and two run sightings', async () => {
    const name = randomUUID(),
      a = await job(),
      b = await job();
    await Promise.all([ingest(a, name), ingest(b, name)]);
    const rows = await links(await finding(name));
    expect(rows).toHaveLength(1);
    expect(rows[0].timesSeen).toBe(2);
    expect([a.jobHistory.id, b.jobHistory.id]).toContain(
      rows[0].firstSeenJobHistoryId,
    );
    expect(rows[0].lastSeenJobHistoryId).not.toBe(
      rows[0].firstSeenJobHistoryId,
    );
    expect(await observations(await finding(name))).toHaveLength(2);
  });

  it('deduplicates concurrent callbacks from different jobs of the same run', async () => {
    const name = randomUUID(),
      a = await job();
    const b = await job('project', 0, a.jobHistory.id);
    await Promise.all([
      ingest(a, name),
      ingest(b, name),
      ingest(a, name),
      ingest(b, name),
    ]);
    const id = await finding(name);
    expect((await links(id))[0].timesSeen).toBe(1);
    expect(await observations(id)).toHaveLength(1);
  });

  it('counts a new run without moving a later stored sighting date backward', async () => {
    const name = randomUUID(),
      a = await job(),
      b = await job();
    await ingest(a, name);
    const id = await finding(name),
      [before] = await links(id);
    const future = new Date('2099-01-01T00:00:00.000Z');
    await app.dataSource.query(
      'UPDATE project_vulnerabilities SET "lastSeenAt" = $1 WHERE id = $2',
      [future, before.id],
    );
    await ingest(b, name);
    const [after] = await links(id);
    expect(after).toMatchObject({
      timesSeen: 2,
      firstSeenAt: before.firstSeenAt,
      lastSeenAt: future,
      lastSeenJobHistoryId: a.jobHistory.id,
    });
    expect(await observations(id)).toHaveLength(2);
  });

  it('preserves missing legacy first/last observations before a new run replaces last', async () => {
    const name = randomUUID(),
      a = await job(),
      b = await job();
    await ingest(a, name);
    await ingest(b, name);
    const id = await finding(name),
      before = await links(id);
    await app.dataSource.query(
      'DELETE FROM project_vulnerability_observations WHERE "projectVulnerabilityId" = $1',
      [before[0].id],
    );
    const c = await job();
    await ingest(c, name);
    const latest = await links(id);
    expect(latest[0]).toMatchObject({
      timesSeen: 3,
      lastSeenJobHistoryId: c.jobHistory.id,
    });
    await ingest(a, name);
    await ingest(b, name);
    const after = await links(id);
    for (const key of [
      'timesSeen',
      'firstSeenAt',
      'lastSeenAt',
      'firstSeenJobHistoryId',
      'lastSeenJobHistoryId',
    ])
      expect(after[0][key]).toEqual(latest[0][key]);
    expect(after[0].timesSeen).toBe(3);
    expect(await observations(id)).toHaveLength(3);
  });

  it('retains aggregate sightings and observation dates when a run is deleted', async () => {
    const name = randomUUID(),
      a = await job(),
      b = await job();
    await ingest(a, name);
    await ingest(b, name);
    const id = await finding(name),
      before = await links(id),
      seen = await observations(id);
    await app.dataSource.query('DELETE FROM job_histories WHERE id = $1', [
      a.jobHistory.id,
    ]);
    const after = await links(id),
      remaining = await observations(id);
    expect(after[0]).toMatchObject({
      timesSeen: 2,
      firstSeenAt: before[0].firstSeenAt,
      lastSeenAt: before[0].lastSeenAt,
      firstSeenJobHistoryId: null,
      lastSeenJobHistoryId: b.jobHistory.id,
    });
    expect(remaining).toHaveLength(2);
    expect(remaining.find((row) => row.jobHistoryId === null)?.seenAt).toEqual(
      seen.find((row) => row.jobHistoryId === a.jobHistory.id)?.seenAt,
    );
    await ingest(b, name);
    expect(await links(id)).toEqual(after);
  });

  it('handles concurrent batches with reversed finding order without duplicate sightings', async () => {
    const names = [randomUUID(), randomUUID()];
    const sources = await Promise.all([job(), job(), job()]);
    await Promise.all(
      sources.map((source, index) =>
        adapter.vulnerabilities({
          job: source,
          data: (index % 2 ? [...names].reverse() : names).map((name) => ({
            name,
            severity: Severity.HIGH,
          })) as Vulnerability[],
        }),
      ),
    );
    for (const name of names) {
      const id = await finding(name);
      expect((await links(id))[0].timesSeen).toBe(3);
      expect(await observations(id)).toHaveLength(3);
    }
  });

  it.each([
    'standalone',
    'foreign-project',
    'foreign-workflow',
    'foreign-asset',
  ])('does not attribute a %s result', async (kind) => {
    const name = randomUUID(),
      source = await job(kind);
    // A supplied object must never override the run's private persisted identity.
    source.jobHistory.projectId = projects[0];
    await ingest(source, name);
    expect(await links(await finding(name))).toEqual([]);
  });

  it('rolls back both finding and initial link when later ingestion fails', async () => {
    const name = randomUUID(),
      source = await job();
    const before: { count: string }[] = await app.dataSource.query(
      'SELECT COUNT(*) FROM project_vulnerabilities',
    );
    const observationsBefore: { count: string }[] = await app.dataSource.query(
      'SELECT COUNT(*) FROM project_vulnerability_observations',
    );
    const fail = jest
      .spyOn(app.app.get(WorkspacesService), 'getMemberOfWorkspaceByJobId')
      .mockRejectedValueOnce(new Error('synthetic rollback'));
    try {
      await expect(ingest(source, name)).rejects.toThrow('synthetic rollback');
    } finally {
      fail.mockRestore();
    }
    expect(
      await app.dataSource.query(
        'SELECT id FROM vulnerabilities WHERE name = $1',
        [name],
      ),
    ).toEqual([]);
    expect(
      await app.dataSource.query(
        'SELECT COUNT(*) FROM project_vulnerabilities',
      ),
    ).toEqual(before);
    expect(
      await app.dataSource.query(
        'SELECT COUNT(*) FROM project_vulnerability_observations',
      ),
    ).toEqual(observationsBefore);
  });
});
