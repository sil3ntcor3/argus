import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Target overview API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let target: string;
  let emptyTarget: string;
  let foreignTarget: string;
  const emptyExposure = { ports: [], technologies: [], statusCodes: [] };
  const missingSchedule = { kind: 'no_schedule', level: 'info' };
  const newAssets = { kind: 'new_assets', level: 'info', count: 1, days: 7 };
  const noOpenFindings = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const redactedFindings = { openVulnerabilities: null, newVulnerabilities: null };
  const findingCounts = {
    openVulnerabilities: { ...noOpenFindings, critical: 1, high: 2 },
    newVulnerabilities: 2,
  };
  const metrics = {
    totalAssets: 2,
    newAssets: 1,
    totalServices: 4,
    newServices: 3,
    openPorts: 2,
    ...findingCounts,
    insights: [newAssets, missingSchedule],
    exposure: {
      ports: [
        { name: '80', count: 2 },
        { name: '443', count: 2 },
      ],
      technologies: [
        { name: 'Nginx', count: 2 },
        { name: 'Apache', count: 1 },
      ],
      statusCodes: [
        { name: '200', count: 2 },
        { name: '404', count: 1 },
      ],
    },
  };

  const overview = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/targets/${id}/overview`).set(headers);

  async function insertId(sql: string, args: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      args,
    );
    return row.id;
  }

  function makeTarget(workspaceId: string) {
    return insertId(
      `INSERT INTO targets (value, type, "workspaceId") VALUES ($1, 'DOMAIN', $2)`,
      [`${randomUUID()}.example.test`, workspaceId],
    );
  }

  async function addAsset(id: string, days: number, enabled: boolean) {
    return insertId(
      `INSERT INTO assets (value, "targetId", "isEnabled", "createdAt")
       VALUES ($1, $2, $3, LOCALTIMESTAMP - $4 * INTERVAL '1 day')`,
      [`${randomUUID()}.example.test`, id, enabled, days],
    );
  }

  async function addService(asset: string, port: number, days = 0) {
    return insertId(
      `INSERT INTO asset_services (value, port, "assetId", "createdAt")
       VALUES ($1, $2, $3, LOCALTIMESTAMP - $4 * INTERVAL '1 day')`,
      [`https://example.test:${port}`, port, asset, days],
    );
  }

  async function observe(service: string, name: string, code: number) {
    const response = await insertId(
      'INSERT INTO http_responses ("assetServiceId") VALUES ($1)',
      [service],
    );
    await app.dataSource.query(
      'INSERT INTO http_response_technologies ("httpResponseId", "assetServiceId", name) VALUES ($1, $2, $3)',
      [response, service, name],
    );
    await app.dataSource.query(
      `INSERT INTO http_status_codes ("httpResponseId", "assetServiceId", "statusCode", "isPrimary")
       VALUES ($1, $2, $3, true), ($1, $2, 301, false)`,
      [response, service, code],
    );
    return response;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'overview-owner');
    other = await createUserWithWorkspace(app.server, 'overview-other');
    target = await makeTarget(owner.workspace.id);
    emptyTarget = await makeTarget(owner.workspace.id);
    foreignTarget = await makeTarget(other.workspace.id);

    const recent = await addAsset(target, 6, true);
    const older = await addAsset(target, 8, true);
    const disabled = await addAsset(target, 1, false);
    const foreign = await addAsset(foreignTarget, 1, true);
    for (const [asset, severity, age, archived, dismissed] of [
      [recent, 'critical', 6, false, false],
      [older, 'high', 8, false, false],
      [disabled, 'high', 1, false, false],
      [recent, 'critical', 1, true, false],
      [recent, 'critical', 1, false, true],
      [foreign, 'critical', 1, false, false],
    ] as const) {
      const id = await insertId(
        `INSERT INTO vulnerabilities (name, severity, "assetId", "isArchived", "createdAt")
         VALUES ($1, $2, $3, $4, LOCALTIMESTAMP - $5 * INTERVAL '1 day')`,
        [randomUUID(), severity, asset, archived, age],
      );
      if (dismissed) {
        await app.dataSource.query(
          `INSERT INTO vulnerability_dismissals ("vulnerabilityId", "userId", reason)
           VALUES ($1, $2, $3)`,
          [id, owner.user.userId, 'Fixture dismissal'],
        );
      }
    }
    const https = await addService(recent, 443, 6);
    await observe(https, 'Nginx', 200);
    await observe(https, 'Nginx', 200);
    await observe(await addService(older, 443, 1), 'Nginx', 200);
    await observe(await addService(recent, 80, 8), 'Apache', 404);
    await addService(disabled, 80, 1);
    const foreignService = await addService(foreign, 22, 1);
    const foreignResponses = [
      await observe(foreignService, 'Foreign', 503),
      await observe(foreignService, 'Foreign', 0),
    ];
    // The response parent remains authoritative if a denormalized ID disagrees.
    for (const table of ['http_response_technologies', 'http_status_codes']) {
      await app.dataSource.query(
        `UPDATE ${table} SET "assetServiceId" = $1 WHERE "httpResponseId" = ANY($2::uuid[])`,
        [https, foreignResponses],
      );
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
          Boolean,
        ),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('counts enabled assets and discovered services without duplicating ports or leaking another target', async () => {
    await overview(target, owner.headers)
      .expect(200, metrics)
      .expect('Cache-Control', 'private, no-store');
    await overview(emptyTarget, owner.headers).expect(200, {
      totalAssets: 0,
      newAssets: 0,
      totalServices: 0,
      newServices: 0,
      openPorts: 0,
      openVulnerabilities: noOpenFindings,
      newVulnerabilities: 0,
      exposure: emptyExposure,
      insights: [missingSchedule],
    });
    await overview(foreignTarget, other.headers).expect(200, {
      totalAssets: 1,
      newAssets: 1,
      totalServices: 1,
      newServices: 1,
      openPorts: 1,
      openVulnerabilities: { ...noOpenFindings, critical: 1 },
      newVulnerabilities: 1,
      insights: [newAssets, missingSchedule],
      exposure: {
        ports: [{ name: '22', count: 1 }],
        technologies: [{ name: 'Foreign', count: 1 }],
        statusCodes: [{ name: '503', count: 1 }],
      },
    });
  });

  it('limits each exposure list to six rows with stable ties', async () => {
    const rankedTarget = await makeTarget(owner.workspace.id);
    const asset = await addAsset(rankedTarget, 1, true);
    for (let i = 6; i >= 0; i--) {
      await observe(
        await addService(asset, 8000 + i),
        `Technology ${i}`,
        200 + i,
      );
    }
    const response = await overview(rankedTarget, owner.headers).expect(200);
    const firstSix = (name: (index: number) => string) =>
      Array.from({ length: 6 }, (_, i) => ({ name: name(i), count: 1 }));
    expect(response.body.exposure).toEqual({
      ports: firstSix((i) => String(8000 + i)),
      technologies: firstSix((i) => `Technology ${i}`),
      statusCodes: firstSix((i) => String(200 + i)),
    });
  });

  it('uses the same stale rule for old and absent discovery dates', async () => {
    const id = await makeTarget(owner.workspace.id);
    await app.dataSource.query(
      `UPDATE targets SET "lastDiscoveredAt" = NULL, "scanSchedule" = NULL WHERE id = $1`,
      [id],
    );
    const never = await overview(id, owner.headers).expect(200);
    expect(never.body.insights).toEqual([
      { kind: 'stale_scan', level: 'warning' },
      missingSchedule,
    ]);

    for (const [days, expected] of [
      [31, [{ kind: 'stale_scan', level: 'warning', days: 31 }]],
      [29, []],
    ] as const) {
      await app.dataSource.query(
        `UPDATE targets SET "lastDiscoveredAt" = LOCALTIMESTAMP - $2 * INTERVAL '1 day',
                            "scanSchedule" = '0 0 * * *' WHERE id = $1`,
        [id, days],
      );
      const result = await overview(id, owner.headers).expect(200);
      expect(result.body.insights).toEqual(expected);
    }
  });

  it('counts only the latest dated TLS certificate per service in the selected target', async () => {
    async function record(
      service: string,
      age: number,
      expiresIn: number | null,
      denormalizedService = service,
    ) {
      const response = await insertId(
        `INSERT INTO http_responses ("assetServiceId", "createdAt")
         VALUES ($1, LOCALTIMESTAMP - $2 * INTERVAL '1 day')`,
        [service, age],
      );
      // Backfilled certificates shared a timestamp. Give older probes larger
      // certificate IDs so the test catches sorting by certificate fields.
      const certificateId = `${String(age).padStart(8, '0')}${randomUUID().slice(8)}`;
      await app.dataSource.query(
        `INSERT INTO tls_certificates (id, "httpResponseId", "assetServiceId", "createdAt", "notAfter")
         VALUES ($1, $2, $3, TIMESTAMP '2026-01-01 00:00:00',
                 CURRENT_TIMESTAMP + $4 * INTERVAL '1 day')`,
        [certificateId, response, denormalizedService, expiresIn],
      );
    }

    const id = await makeTarget(owner.workspace.id);
    const asset = await addAsset(id, 8, true);
    const expiring = await addService(asset, 443);
    const renewed = await addService(asset, 8443);
    const expired = await addService(asset, 9443);
    const undated = await addService(asset, 10443);
    await record(expiring, 2, 5);
    await record(expiring, 1, 14);
    await record(renewed, 2, -1);
    await record(renewed, 1, 60);
    await record(expired, 2, -1);
    await record(expired, 1, null);
    await record(undated, 1, null);

    const foreign = await makeTarget(other.workspace.id);
    const foreignAsset = await addAsset(foreign, 8, true);
    await record(await addService(foreignAsset, 443), 0, 3, renewed);
    const warning = (count: number) => ({
      kind: 'tls_expiring',
      level: 'warning',
      count,
      days: 30,
    });
    const ownedOverview = await overview(id, owner.headers).expect(200);
    const foreignOverview = await overview(foreign, other.headers).expect(200);
    expect(ownedOverview.body.insights).toEqual([
      warning(2),
      missingSchedule,
    ]);
    expect(foreignOverview.body.insights).toEqual([
      warning(1),
      missingSchedule,
    ]);
  });

  it('returns the same 404 for a missing target or one in another workspace', async () => {
    const missing = await overview(randomUUID(), owner.headers).expect(404);
    const foreign = await overview(foreignTarget, owner.headers).expect(404);
    expect(foreign.body).toEqual(missing.body);
    await overview('not-a-uuid', owner.headers).expect(400);
  });

  it('requires both target and asset read access in the selected workspace', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await overview(target, {}).expect(401);
    await overview(target, headers).expect(403);
    const member = await insertId(
      `INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)`,
      [workspace, other.user.userId],
    );
    const role = await insertId(
      `INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)`,
      [randomUUID(), ['target.read'], workspace],
    );
    await app.dataSource.query(
      `INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)`,
      [member, role],
    );
    await overview(target, headers).expect(403);
    for (const [permissions, allowed] of [
      [['asset.read'], false],
      [['target.read', 'asset.read'], true],
      [['target.write', 'asset.write'], true],
    ] as const) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [permissions, role],
      );
      if (allowed)
        await overview(target, headers).expect(200, {
          ...metrics,
          ...redactedFindings,
        });
      else await overview(target, headers).expect(403);
    }

    for (const findingPermission of ['vulnerability.read', 'vulnerability.write']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [['target.read', 'asset.read', findingPermission], role],
      );
      await overview(target, headers).expect(200, metrics);
    }
    const restrictedMetrics = { ...metrics, ...redactedFindings };
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
      [['target.read', 'asset.read'], role],
    );
    const workflows = await app.dataSource.query<
      { id: string; workspaceId: string }[]
    >(
      'SELECT DISTINCT ON ("workspaceId") id, "workspaceId" FROM workflows WHERE "workspaceId" IN ($1, $2)',
      [workspace, other.workspace.id],
    );
    const ownedWorkflow = workflows.find(
      (workflow) => workflow.workspaceId === workspace,
    )!;
    const foreignWorkflow = workflows.find(
      (workflow) => workflow.workspaceId !== workspace,
    )!;
    const makeRun = (workflow: string, age: number, id = randomUUID()) =>
      insertId(
        `INSERT INTO job_histories ("workflowId", scope, "createdAt", id)
         VALUES ($1, $2, LOCALTIMESTAMP - $3 * INTERVAL '1 day', $4)`,
        [workflow, { targetIds: [target] }, age, id],
      );
    const failed = await makeRun(
      ownedWorkflow.id,
      2,
      '00000000-0000-4000-8000-000000000001',
    );
    await makeRun(foreignWorkflow.id, 1);
    const siblingAsset = await addAsset(await makeTarget(workspace), 8, true);
    const [tool] = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM tools WHERE name = $1',
      ['nuclei'],
    );
    await app.dataSource.query(
      `INSERT INTO jobs ("jobHistoryId", "assetId", "toolId", category, status)
       VALUES ($1, $2, $3, 'vulnerabilities', 'failed')`,
      [failed, siblingAsset, tool.id],
    );

    // A failure on a sibling asset still sets the whole run's status. Its ID
    // is visible only with effective job read access.
    const failedMetrics = {
      ...metrics,
      insights: [
        { kind: 'last_run_failed', level: 'warning', runId: failed },
        ...metrics.insights,
      ],
    };
    await overview(target, headers).expect(200, restrictedMetrics);
    await overview(target, owner.headers).expect(200, failedMetrics);
    for (const jobPermission of ['job.read', 'job.write']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [['target.read', 'asset.read', jobPermission], role],
      );
      await overview(target, headers).expect(200, {
        ...failedMetrics,
        ...redactedFindings,
      });
    }
    // For equal timestamps, run history and the insight both prefer the
    // greater ID. A pending run wins the tie and suppresses the warning.
    await app.dataSource.query(
      `INSERT INTO job_histories (id, "workflowId", scope, "createdAt")
       SELECT 'ffffffff-ffff-4fff-bfff-ffffffffffff', "workflowId", scope, "createdAt"
       FROM job_histories WHERE id = $1`,
      [failed],
    );
    await overview(target, headers).expect(200, restrictedMetrics);
  });
});
