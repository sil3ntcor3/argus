import { randomUUID } from 'node:crypto';
import { FindingRiskExpiryService } from '@/modules/vulnerabilities/finding-risk-expiry.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding risk expiry (e2e)', () => {
  let app: TestApp;
  let scope: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let asset: string;

  async function insertId(sql: string, params: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      params,
    );
    return row.id;
  }

  async function addDismissal(
    reason: string,
    expiresAt: string | null,
    archived = false,
  ) {
    const finding = await insertId(
      `INSERT INTO vulnerabilities (name, severity, "assetId", "isArchived") VALUES ($1, 'high', $2, $3)`,
      [randomUUID(), asset, archived],
    );
    await insertId(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason, "expiresAt", comment)
       VALUES ($1, $2, $3, $4, 'Stored risk note')`,
      [finding, scope.user.userId, reason, expiresAt],
    );
    return finding;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    scope = await createUserWithWorkspace(app.server, 'risk-expiry');
    const host = `${randomUUID()}.example.test`;
    const target = await insertId(
      `INSERT INTO targets (value, type, "workspaceId") VALUES ($1, 'DOMAIN', $2)`,
      [host, scope.workspace.id],
    );
    asset = await insertId(
      'INSERT INTO assets (value, "targetId") VALUES ($1, $2)',
      [host, target],
    );
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [scope?.workspace.id].filter(Boolean),
        userIds: [scope?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  const fixedNow = new Date('2026-11-09T16:00:00.000Z');
  const expiredAt = '2026-11-09T15:00:00.000Z';

  it('expires only due risk acceptances and records their history once across simultaneous sweeps', async () => {
    const due = await addDismissal('risk_accepted', expiredAt);
    const boundary = await addDismissal(
      'risk_accepted',
      fixedNow.toISOString(),
      true,
    );
    const future = await addDismissal(
      'risk_accepted',
      '2026-11-10T16:00:00.000Z',
    );
    const indefinite = await addDismissal('risk_accepted', null);
    const unrelated = await addDismissal('wont_fix', expiredAt);
    const service = app.app.get(FindingRiskExpiryService);
    const results = await Promise.all([
      service.expireDue(fixedNow),
      service.expireDue(fixedNow),
    ]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(2);

    const rows = await app.dataSource.query<{ vulnerabilityId: string }[]>(
      `SELECT "vulnerabilityId" FROM vulnerability_dismissals WHERE "vulnerabilityId"=ANY($1::uuid[])`,
      [[due, boundary, future, indefinite, unrelated]],
    );
    expect(rows.map((row) => row.vulnerabilityId).sort()).toEqual(
      [future, indefinite, unrelated].sort(),
    );
    const events = await app.dataSource.query<
      {
        vulnerabilityId: string;
        workspaceId: string;
        occurredAt: Date;
        data: unknown;
      }[]
    >(
      `SELECT "vulnerabilityId", "workspaceId", "occurredAt", data
       FROM vulnerability_events WHERE "vulnerabilityId"=ANY($1::uuid[]) AND type='risk_expired'`,
      [[due, boundary]],
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          vulnerabilityId: due,
          workspaceId: scope.workspace.id,
          occurredAt: fixedNow,
          data: expect.objectContaining({
            acceptedById: scope.user.userId,
            comment: 'Stored risk note',
          }),
        }),
        expect.objectContaining({
          vulnerabilityId: boundary,
          workspaceId: scope.workspace.id,
          occurredAt: fixedNow,
        }),
      ]),
    );
    expect(events).toHaveLength(2);
    const [finding] = await app.dataSource.query<{ isArchived: boolean }[]>(
      'SELECT "isArchived" FROM vulnerabilities WHERE id=$1',
      [boundary],
    );
    expect(finding.isArchived).toBe(true);
  });

  it('skips an owner locked for deletion and retries safely later', async () => {
    await addDismissal('risk_accepted', expiredAt);
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const service = app.app.get(FindingRiskExpiryService);
    try {
      await runner.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [
        scope.workspace.id,
      ]);
      await expect(service.expireDue(fixedNow)).resolves.toBe(0);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    await expect(service.expireDue(fixedNow)).resolves.toBe(1);
  });

  it('skips a locked dismissal and continues beyond the first page', async () => {
    const finding = await addDismissal('risk_accepted', expiredAt);
    await app.dataSource.query(
      `WITH batch AS (
         INSERT INTO vulnerabilities (name, severity, "assetId")
         SELECT 'Expiry cursor fixture ' || position, 'high', $1
         FROM generate_series(1, 500) AS position RETURNING id
       )
       INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason, "expiresAt")
       SELECT id, $2, 'risk_accepted', $3 FROM batch`,
      [asset, scope.user.userId, fixedNow],
    );
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const service = app.app.get(FindingRiskExpiryService);
    let pending: Promise<number> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completedBeforeRelease: number | undefined;
    try {
      await runner.query(
        'SELECT id FROM vulnerability_dismissals WHERE "vulnerabilityId"=$1 FOR UPDATE',
        [finding],
      );
      pending = service.expireDue(fixedNow);
      completedBeforeRelease = await Promise.race([
        pending,
        new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(-1), 1500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await runner.rollbackTransaction();
      await runner.release();
      await pending;
    }
    expect(completedBeforeRelease).toBe(500);
    await expect(service.expireDue(fixedNow)).resolves.toBe(1);
  });
});
