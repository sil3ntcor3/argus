import { Severity } from '@/common/enums/enum';
import {
  DataAdapterService,
  vulnerabilityFingerprint,
} from '@/modules/data-adapter/data-adapter.service';
import { Job } from '@/modules/jobs-registry/entities/job.entity';
import { VulnerabilityEvent } from '@/modules/vulnerabilities/entities/vulnerability-event.entity';
import type { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Scanner resurfacing (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let adapter: DataAdapterService;
  let workflow: string;
  let tool: string;
  let asset: string;
  const fixedAt = new Date('2026-11-01T07:00:00.000Z');

  async function insert(sql: string, params: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      params,
    );
    return row.id;
  }

  async function jobAfter(milliseconds: number | null) {
    const history = await insert(
      'INSERT INTO job_histories ("workflowId") VALUES ($1)',
      [workflow],
    );
    const id = await insert(
      `INSERT INTO jobs ("assetId","toolId","jobHistoryId",category,status,"pickJobAt","findingScanScopeKey","findingScanClaimedAt")
       VALUES ($1,$2,$3,'vulnerabilities','in_progress',$4,$5,$6)`,
      [
        asset,
        tool,
        history,
        // Both folds of the DST transition can have the same legacy wall time.
        '2026-11-01 01:30:00',
        'f'.repeat(64),
        milliseconds === null ? null : new Date(fixedAt.getTime() + milliseconds),
      ],
    );
    return app.dataSource.getRepository(Job).findOneOrFail({
      where: { id },
      relations: { asset: { target: true }, tool: true, jobHistory: true },
    });
  }

  async function fixedFinding(originalJob: Job, isArchived = false) {
    const name = 'Resurface fixture ' + randomUUID();
    const fingerprint = vulnerabilityFingerprint({
      name,
      assetId: asset,
      toolId: tool,
      isRepositoryAsset: false,
    });
    const id = await insert(
      `INSERT INTO vulnerabilities
         (name, severity, fingerprint, "assetId", "toolId", "jobHistoryId",
          "firstDetectedDate", "detectionStatus", "fixedAt", "missedScans", "isArchived")
       VALUES ($1,'high',$2,$3,$4,$5,$6,'fixed',$7,3,$8)`,
      [
        name, fingerprint, asset, tool, originalJob.jobHistory.id,
        new Date(fixedAt.getTime() - 120_000), fixedAt, isArchived,
      ],
    );
    return { id, name };
  }

  async function state(id: string) {
    const [row] = await app.dataSource.query<{
      detectionStatus: string;
      fixedAt: Date | null;
      missedScans: number;
      resurfacedCount: number;
      isArchived: boolean;
    }[]>(
      `SELECT "detectionStatus","fixedAt","missedScans","resurfacedCount","isArchived"
       FROM vulnerabilities WHERE id = $1`,
      [id],
    );
    return row;
  }

  function report(job: Job, name: string) {
    return adapter.vulnerabilities({
      job,
      data: [{ name, severity: Severity.HIGH } as Vulnerability],
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'scanner-resurface');
    adapter = app.app.get(DataAdapterService);
    const host = randomUUID() + '.example.test';
    const target = await insert(
      `INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2)`,
      [host, owner.workspace.id],
    );
    asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [host, target]);
    tool = await insert('INSERT INTO tools (name,categories) VALUES ($1,$2)', [
      randomUUID(),
      JSON.stringify([{ name: 'vulnerabilities', targetTypes: ['DOMAIN'] }]),
    ]);
    const name = randomUUID();
    workflow = await insert(
      `INSERT INTO workflows (name,content,"filePath","workspaceId") VALUES ($1,'{}',$1,$2)`,
      [name, owner.workspace.id],
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId].filter(Boolean),
      });
      if (tool) await app.dataSource.query('DELETE FROM tools WHERE id = $1', [tool]);
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('resurfaces only after a newer scan, then activates on a different run', async () => {
    const original = await jobAfter(-120_000);
    const finding = await fixedFinding(original);
    const delayed = await jobAfter(-30 * 60_000);
    await report(delayed, finding.name);
    expect(await state(finding.id)).toMatchObject({
      detectionStatus: 'fixed', fixedAt, missedScans: 3, resurfacedCount: 0,
    });
    const ambiguous = await jobAfter(5_000);
    await app.dataSource.query(
      'UPDATE jobs SET "findingScanScopeKey" = NULL WHERE id = $1',
      [ambiguous.id],
    );
    await report(ambiguous, finding.name);
    expect(await state(finding.id)).toMatchObject({
      detectionStatus: 'fixed', fixedAt, missedScans: 3, resurfacedCount: 0,
    });
    const legacy = await jobAfter(null);
    await report(legacy, finding.name);
    const simultaneous = await jobAfter(0);
    await report(simultaneous, finding.name);
    const cancelled = await jobAfter(5_000);
    await app.dataSource.query("UPDATE jobs SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    await report(cancelled, finding.name);
    expect(await state(finding.id)).toMatchObject({
      detectionStatus: 'fixed', fixedAt, missedScans: 3, resurfacedCount: 0,
    });
    const fresh = await jobAfter(30 * 60_000);
    await Promise.all([report(fresh, finding.name), report(fresh, finding.name)]);
    expect(await state(finding.id)).toMatchObject({
      detectionStatus: 'resurfaced', fixedAt: null, missedScans: 0, resurfacedCount: 1,
    });
    await app.dataSource.query('UPDATE vulnerabilities SET "missedScans" = 2 WHERE id = $1', [finding.id]);
    const next = await jobAfter(40 * 60_000);
    await report(next, finding.name);
    expect(await state(finding.id)).toMatchObject({
      detectionStatus: 'active', missedScans: 2, resurfacedCount: 1,
    });
    const events = await app.dataSource.getRepository(VulnerabilityEvent).find({
      where: { vulnerabilityId: finding.id, type: 'status_changed' },
      order: { occurredAt: 'ASC' },
    });
    expect(events.map(({ fromStatus, toStatus, jobHistoryId }) => ({
      fromStatus, toStatus, jobHistoryId,
    }))).toEqual([
      { fromStatus: 'fixed', toStatus: 'resurfaced', jobHistoryId: fresh.jobHistory.id },
      { fromStatus: 'resurfaced', toStatus: 'active', jobHistoryId: next.jobHistory.id },
    ]);
  });

  it('records first and repeat positive sightings with the database clock', async () => {
    const job = await jobAfter(null);
    const name = 'Observation fixture ' + randomUUID();
    const observation = async () => {
      const [row] = await app.dataSource.query<{
        id: string; lastScannerObservedAt: Date | null; timesDetected: number;
      }[]>(
        'SELECT id,"lastScannerObservedAt","timesDetected" FROM vulnerabilities WHERE name=$1',
        [name],
      );
      return row;
    };
    const [{ now: before }] = await app.dataSource.query<{ now: Date }[]>(
      'SELECT statement_timestamp() AS now',
    );

    await report(job, name);

    const first = await observation();
    const [{ now: after }] = await app.dataSource.query<{ now: Date }[]>(
      'SELECT statement_timestamp() AS now',
    );
    expect(first.lastScannerObservedAt).toBeInstanceOf(Date);
    expect(first.lastScannerObservedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(first.lastScannerObservedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(first.timesDetected).toBe(1);

    // Give the two database instants distinct milliseconds on fast hosts.
    await app.dataSource.query('SELECT pg_sleep(0.01)');
    await report(job, name);

    const repeated = await observation();
    expect(repeated.lastScannerObservedAt!.getTime()).toBeGreaterThan(first.lastScannerObservedAt!.getTime());
    expect(repeated.timesDetected).toBe(1);

    const removed = await jobAfter(null);
    // The processor already read this claim; its job row disappears before sync.
    await app.dataSource.query('DELETE FROM jobs WHERE id=$1', [removed.id]);
    await app.dataSource.query('SELECT pg_sleep(0.01)');
    await report(removed, name);
    const unattributed = await observation();
    expect(unattributed.lastScannerObservedAt!.getTime()).toBeGreaterThan(repeated.lastScannerObservedAt!.getTime());
    expect(unattributed.timesDetected).toBe(1);
    const [source] = await app.dataSource.query<{ count: number }[]>(
      'SELECT COUNT(*)::int AS count FROM vulnerability_sources WHERE "vulnerabilityId"=$1',
      [first.id],
    );
    expect(source.count).toBe(1);
  });

  it('preserves the fork’s archive on a later positive scan', async () => {
    const finding = await fixedFinding(await jobAfter(-120_000), true);
    await report(await jobAfter(10_000), finding.name);
    expect(await state(finding.id)).toMatchObject({
      isArchived: true, detectionStatus: 'fixed', fixedAt, missedScans: 3, resurfacedCount: 0,
    });
  });
});
