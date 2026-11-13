import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { DataAdapterService, vulnerabilityFingerprint } from '@/modules/data-adapter/data-adapter.service';
import { Job } from '@/modules/jobs-registry/entities/job.entity';
import { FindingScanAccountingService } from '@/modules/jobs-registry/finding-scan-accounting.service';
import type { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

const scope = 'image-v1:' + 'a'.repeat(64);
const observed = '2026-11-01T00:00:00Z';
const negative = '2026-11-12T00:00:00.123456Z';

describe('Trusted finding closure (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let toolId: string;
  let workflowId: string;
  let assetId: string;
  let findingId: string;
  let name: string;
  const runIds: string[] = [];
  const insert = async (sql: string, values: unknown[]) => {
    const [{ id }] = await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values);
    return id;
  };
  const scan = async (options: {
    at?: string; key?: string; coverage?: boolean | null; status?: string;
    completed?: boolean; runId?: string; template?: boolean;
  } = {}) => {
    const runId = options.runId ?? await insert(
      'INSERT INTO job_histories ("workflowId", "isCompleted") VALUES ($1,$2)',
      [options.template ? null : workflowId, options.completed ?? true],
    );
    if (!options.runId) runIds.push(runId);
    const jobId = await insert(
      `INSERT INTO jobs ("assetId","toolId","jobHistoryId",category,status,
         "findingScanScopeKey","findingScanClaimedAt","findingScanCoverageComplete")
       VALUES ($1,$2,$3,'vulnerabilities',$4,$5,$6,$7)`,
      [assetId, toolId, runId, options.status ?? 'completed', options.key ?? scope,
        options.at ?? negative, options.coverage === undefined ? true : options.coverage],
    );
    if (options.template) await app.dataSource.query(`UPDATE jobs SET inputs=$2 WHERE id=$1`,
      [jobId, { __argus_saved_template_selection_v1: JSON.stringify({ ids: [randomUUID()], actorId: owner.user.userId }) }]);
    return { runId, jobId };
  };
  const complete = (runId: string) => app.app.get(FindingScanAccountingService)
    .onWorkflowEnd({ jobHistory: { id: runId } } as Job);
  const state = async () => (await app.dataSource.query<{
    detectionStatus: string; missedScans: number; fixedAt: Date | null;
    fixedByJobHistoryId: string | null;
  }[]>(`SELECT "detectionStatus","missedScans","fixedAt","fixedByJobHistoryId"
       FROM vulnerabilities WHERE id=$1`, [findingId]))[0];
  const events = () => app.dataSource.query<{ data: Record<string, unknown> }[]>(
    `SELECT data FROM vulnerability_events WHERE "vulnerabilityId"=$1 AND "toStatus"='fixed'`, [findingId],
  );
  const waitForFindingLock = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [{ waiting }] = await app.dataSource.query<{ waiting: boolean }[]>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%completed_scope%') AS waiting`,
      );
      if (waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Closure did not reach the finding lock');
  };
  const positive = async (at: string, key = scope, template = false) => {
    const { jobId, runId } = await scan({ at, key, status: 'in_progress', completed: false, coverage: null, template });
    const job = await app.dataSource.getRepository(Job).findOneOrFail({
      where: { id: jobId }, relations: { asset: { target: true }, tool: true, jobHistory: true },
    });
    await app.app.get(DataAdapterService).vulnerabilities({
      data: [{ name, severity: 'high' } as Vulnerability], job,
    });
    return runId;
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'auto-close');
    [{ id: toolId }] = await app.dataSource.query<{ id: string }[]>(
      `SELECT id FROM tools WHERE name='nuclei'`,
    );
    workflowId = await insert(
      `INSERT INTO workflows(name,content,"filePath","workspaceId") VALUES($1,'{}',$1,$2)`,
      [randomUUID(), owner.workspace.id],
    );
  });

  beforeEach(async () => {
    await app.dataSource.query(`UPDATE workspaces SET settings='{}'::jsonb WHERE id=$1`, [owner.workspace.id]);
    const target = await insert(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
      [randomUUID() + '.example.test', owner.workspace.id]);
    assetId = await insert(`INSERT INTO assets(value,"targetId") VALUES($1,$2)`, ['auto-close.example.test', target]);
    name = randomUUID();
    findingId = await insert(
      `INSERT INTO vulnerabilities(name,severity,fingerprint,"assetId","toolId","scanScopeKey",
         "firstDetectedDate","lastScannerObservedAt") VALUES($1,'high',$2,$3,$4,$5,$6,$6)`,
      [name, vulnerabilityFingerprint({ name, assetId, toolId, isRepositoryAsset: false }),
        assetId, toolId, scope, observed],
    );
  });

  afterAll(async () => {
    if (app) await app.dataSource.query('DELETE FROM job_histories WHERE id=ANY($1::uuid[])', [runIds]);
    if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id].filter(Boolean), userIds: [owner?.user.userId].filter(Boolean),
    });
    await closeTestApp(app?.app);
  });

  it('honors disable and distinct-run thresholds without trusting cached misses', async () => {
    await app.dataSource.query(`UPDATE workspaces SET settings=$2 WHERE id=$1`,
      [owner.workspace.id, { vulnerabilityManagement: { autoCloseEnabled: false } }]);
    const first = await scan();
    await scan({ runId: first.runId });
    await complete(first.runId);
    expect(await state()).toMatchObject({ detectionStatus: 'new', missedScans: 1, fixedAt: null });
    await app.dataSource.query(`UPDATE workspaces SET settings=$2 WHERE id=$1`,
      [owner.workspace.id, { vulnerabilityManagement: { autoCloseMissedScans: 2 } }]);
    await complete(first.runId);
    expect((await state()).detectionStatus).toBe('new');
    const second = await scan({ at: '2026-11-12T01:00:00Z' });
    await complete(second.runId);
    await complete(first.runId);
    expect(await state()).toMatchObject({ detectionStatus: 'fixed', missedScans: 2,
      fixedAt: expect.any(Date), fixedByJobHistoryId: second.runId });
    expect(await events()).toHaveLength(1);
  });

  it.each([
    { coverage: null }, { coverage: false }, { key: 'a'.repeat(64) },
    { key: 'image-v1:' + 'b'.repeat(64) }, { status: 'failed' },
    { status: 'cancelled' }, { completed: false }, { at: observed },
  ])('never closes from incomplete, changed or old evidence: %j', async options => {
    await app.dataSource.query('UPDATE vulnerabilities SET "missedScans"=10 WHERE id=$1', [findingId]);
    const run = await scan(options);
    await complete(run.runId);
    expect(await state()).toMatchObject({ detectionStatus: 'new', fixedAt: null });
    expect(await events()).toHaveLength(0);
  });

  it('excludes a positive source and runs with cancelled or unfinished jobs', async () => {
    const positiveRun = await scan();
    await insert(`INSERT INTO vulnerability_sources("vulnerabilityId",kind,"toolId","jobHistoryId")
      VALUES($1,'tool',$2,$3)`, [findingId, toolId, positiveRun.runId]);
    await complete(positiveRun.runId);
    const unfinished = await scan();
    await scan({ runId: unfinished.runId, status: 'pending', coverage: null });
    await complete(unfinished.runId);
    const cancelled = await scan();
    await scan({ runId: cancelled.runId, status: 'cancelled', coverage: null });
    await complete(cancelled.runId);
    expect(await state()).toMatchObject({ detectionStatus: 'new', fixedAt: null });
  });

  it.each([scope, 'image-v1:' + 'b'.repeat(64)])(
    'records the newest negative cutoff atomically and allows a newer delayed positive (%s)',
    async positiveScope => {
      const old = await scan({ at: '2026-11-11T00:00:00Z' });
      const newest = await scan();
      await complete(old.runId);
      expect((await state()).fixedByJobHistoryId).toBe(newest.runId);
      const [{ exact }] = await app.dataSource.query<{ exact: boolean }[]>(
        `SELECT event."occurredAt"=finding."fixedAt" AND
           (event.data->>'scanClaimedAt')::timestamptz=$2::timestamptz AS exact
         FROM vulnerability_events event JOIN vulnerabilities finding ON finding.id=event."vulnerabilityId"
         WHERE finding.id=$1 AND event."toStatus"='fixed'`, [findingId, negative],
      );
      expect(exact).toBe(true);
      await positive('2026-11-12T00:00:00.123457Z', positiveScope);
      expect(await state()).toMatchObject({ detectionStatus: 'resurfaced', fixedAt: null,
        fixedByJobHistoryId: null, missedScans: 0 });
    },
  );

  it('retains the cutoff after deleting the closing run', async () => {
    const run = await scan();
    await complete(run.runId);
    await app.dataSource.query('DELETE FROM job_histories WHERE id=$1', [run.runId]);
    await positive('2026-11-12T00:00:00.123457Z');
    expect((await state()).detectionStatus).toBe('resurfaced');
  });

  it.each([false, true])('verifies a fix claim only with coverage begun after it: %s', async afterClaim => {
    await request(app.server).post('/api/vulnerabilities/claim-fix').set(owner.headers)
      .send({ vulnerabilityIds: [findingId], note: 'Do not publish this repair note' }).expect(200);
    const [{ at }] = await app.dataSource.query<{ at: string }[]>(
      'SELECT statement_timestamp()::text AS at');
    const run = await scan({ at: afterClaim ? at : negative });
    await complete(run.runId);
    expect((await state()).detectionStatus).toBe('fixed');
    const timeline = await request(app.server).get(`/api/vulnerabilities/${findingId}/timeline`)
      .set(owner.headers).expect(200);
    expect(timeline.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status_changed', toStatus: 'fixed', fixClaimVerified: afterClaim }),
      expect.objectContaining({ type: 'fix_claimed', verification: 'next_covering_scan' }),
    ]));
    for (const privateValue of ['Do not publish this repair note', 'scanClaimedAt', 'coverageVersion', 'actorId'])
      expect(JSON.stringify(timeline.body)).not.toContain(privateValue);
  });

  it('accounts for a workspace-scoped saved-template run with no workflow', async () => {
    const run = await scan({ template: true });
    await complete(run.runId);
    expect(await state()).toMatchObject({ detectionStatus: 'fixed', fixedByJobHistoryId: run.runId });
    const positiveRun = await positive('2026-11-12T00:00:00.123457Z', scope, true);
    expect((await state()).detectionStatus).toBe('resurfaced');
    const [{ lastSeenJobHistoryId }] = await app.dataSource.query<{ lastSeenJobHistoryId: string }[]>(
      'SELECT "lastSeenJobHistoryId" FROM vulnerabilities WHERE id=$1', [findingId]);
    expect(lastSeenJobHistoryId).toBe(positiveRun);
  });

  it.each([true, false])('applies the saved SLA restart policy on a newer positive: %s', async restart => {
    await app.dataSource.query(`UPDATE workspaces SET settings=$2 WHERE id=$1`, [owner.workspace.id,
      { vulnerabilityManagement: { slaRestartOnResurface: restart, slaDays: { high: 3 } } }]);
    await app.dataSource.query(`UPDATE vulnerabilities SET "dueAt"='2026-11-05T00:00:00Z',
      "fixClaimedAt"=statement_timestamp(),"fixClaimedById"=$2 WHERE id=$1`, [findingId, owner.user.userId]);
    const run = await scan(); await complete(run.runId);
    const positiveRun = await positive('2026-11-12T00:00:00.123457Z');
    const [row] = await app.dataSource.query<{ dueAt: Date; fixClaimedAt: Date | null; fixClaimedById: string | null; lastSeenJobHistoryId: string; restarted: boolean }[]>(
      `SELECT finding."dueAt",finding."fixClaimedAt",finding."fixClaimedById",finding."lastSeenJobHistoryId",
        finding."dueAt"=event."occurredAt"+interval '3 days' AS restarted
       FROM vulnerabilities finding JOIN vulnerability_events event ON event."vulnerabilityId"=finding.id
       WHERE finding.id=$1 AND event."toStatus"='resurfaced'`, [findingId]);
    expect(row).toMatchObject({ fixClaimedAt: null, fixClaimedById: null, lastSeenJobHistoryId: positiveRun, restarted: restart });
    if (!restart) expect(row.dueAt).toEqual(new Date('2026-11-05T00:00:00Z'));
  });

  it('rejects standalone runs with unmarked or foreign members', async () => {
    const unmarked = await scan({ template: true });
    await scan({ runId: unmarked.runId });
    await complete(unmarked.runId);
    expect((await state()).detectionStatus).toBe('new');
    const foreign = await scan({ template: true });
    // A removed-workflow run is not a saved-template run merely because another
    // job happens to be marked. Every job must still prove workspace ownership.
    await app.dataSource.query(`INSERT INTO jobs ("toolId","jobHistoryId",category,status,inputs)
      VALUES($1,$2,'vulnerabilities','completed',$3)`, [toolId, foreign.runId,
      { __argus_saved_template_selection_v1: '{}' }]);
    await complete(foreign.runId);
    expect((await state()).detectionStatus).toBe('new');
  });

  it('sees a positive observation that commits while closure waits for its finding lock', async () => {
    const run = await scan();
    const writer = app.dataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    let closing: Promise<void> | undefined;
    try {
      await writer.query(`UPDATE vulnerabilities SET "lastScannerObservedAt"=statement_timestamp()
        WHERE id=$1`, [findingId]);
      closing = complete(run.runId);
      await waitForFindingLock();
      await writer.commitTransaction();
      await closing;
      expect(await state()).toMatchObject({ detectionStatus: 'new', fixedAt: null });
      expect(await events()).toHaveLength(0);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await closing;
    }
  });

  it('rechecks retried evidence after acquiring the finding lock', async () => {
    const run = await scan();
    await app.dataSource.query('UPDATE vulnerabilities SET "missedScans"=10 WHERE id=$1', [findingId]);
    const writer = app.dataSource.createQueryRunner();
    await writer.connect();
    await writer.startTransaction();
    let closing: Promise<void> | undefined;
    try {
      await writer.query('SELECT id FROM vulnerabilities WHERE id=$1 FOR UPDATE', [findingId]);
      closing = complete(run.runId);
      await waitForFindingLock();
      await app.dataSource.query(`UPDATE jobs SET status='pending', "findingScanCoverageComplete"=NULL
        WHERE id=$1`, [run.jobId]);
      await writer.commitTransaction();
      await closing;
      expect(await state()).toMatchObject({ detectionStatus: 'new', fixedAt: null });
      expect(await events()).toHaveLength(0);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await closing;
    }
  });

  it('defers a latest proof whose parent is locked, then closes on a safe replay', async () => {
    const older = await scan({ at: '2026-11-11T00:00:00Z' });
    const newer = await scan();
    const retention = app.dataSource.createQueryRunner();
    await retention.connect();
    await retention.startTransaction();
    try {
      await retention.query('SELECT id FROM job_histories WHERE id=$1 FOR UPDATE', [newer.runId]);
      await complete(older.runId);
      expect(await state()).toMatchObject({ detectionStatus: 'new', fixedAt: null });
      await retention.commitTransaction();
      await complete(older.runId);
      expect(await state()).toMatchObject({ detectionStatus: 'fixed', fixedByJobHistoryId: newer.runId });
    } finally {
      if (retention.isTransactionActive) await retention.rollbackTransaction();
      await retention.release();
    }
  });

  it.each(['tomorrow', 'infinity', '2026-99-99T00:00:00Z', '2099-01-01T00:00:00Z', 1])(
    'falls back safely for malformed or future private cutoff %j', async cutoff => {
      const run = await scan();
      await complete(run.runId);
      await app.dataSource.query(`UPDATE vulnerability_events SET data=jsonb_set(data,
        '{scanClaimedAt}', $2::jsonb) WHERE "vulnerabilityId"=$1 AND "toStatus"='fixed'`,
      [findingId, JSON.stringify(cutoff)]);
      await positive('2026-11-12T00:00:00.123457Z');
      expect((await state()).detectionStatus).toBe('fixed');
    },
  );

  it('does not treat duplicate matching fix events as a unique cutoff', async () => {
    const run = await scan();
    await complete(run.runId);
    await app.dataSource.query(`INSERT INTO vulnerability_events
      ("vulnerabilityId","workspaceId",type,"fromStatus","toStatus","jobHistoryId","occurredAt",data)
      SELECT "vulnerabilityId","workspaceId",type,"fromStatus","toStatus","jobHistoryId","occurredAt",data
      FROM vulnerability_events WHERE "vulnerabilityId"=$1 AND "toStatus"='fixed'`, [findingId]);
    await positive('2026-11-12T00:00:00.123457Z');
    expect((await state()).detectionStatus).toBe('fixed');
  });
});
