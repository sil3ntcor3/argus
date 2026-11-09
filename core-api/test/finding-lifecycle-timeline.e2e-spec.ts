import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding lifecycle timeline API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let finding: string;
  let empty: string;
  let foreign: string;
  let run: string;
  let detected: string;
  let activated: string;
  const occurredAt = '2026-03-14T12:30:00.000Z';

  const timeline = (id: string, headers: Record<string, string>) =>
    request(app.server).get(`/api/vulnerabilities/${id}/timeline`).set(headers);

  async function insertId(sql: string, params: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      params,
    );
    return row.id;
  }

  async function makeAsset(workspace: string) {
    const host = `${randomUUID()}.example.test`;
    const target = await insertId(
      `INSERT INTO targets (value, type, "workspaceId") VALUES ($1, 'DOMAIN', $2)`,
      [host, workspace],
    );
    return insertId('INSERT INTO assets (value, "targetId") VALUES ($1, $2)', [
      host,
      target,
    ]);
  }

  const makeFinding = (asset: string) =>
    insertId(
      `INSERT INTO vulnerabilities (name, severity, "assetId") VALUES ($1, 'high', $2)`,
      ['Timeline fixture', asset],
    );

  async function makeRun(workspace: string) {
    const workflow = await insertId(
      `INSERT INTO workflows (name, content, "filePath", "workspaceId") VALUES ($1, '{}', $1, $2)`,
      [randomUUID(), workspace],
    );
    return insertId('INSERT INTO job_histories ("workflowId") VALUES ($1)', [
      workflow,
    ]);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'timeline-owner');
    other = await createUserWithWorkspace(app.server, 'timeline-other');
    const ownedAsset = await makeAsset(owner.workspace.id);
    finding = await makeFinding(ownedAsset);
    empty = await makeFinding(ownedAsset);
    foreign = await makeFinding(await makeAsset(other.workspace.id));
    run = await makeRun(owner.workspace.id);
    const foreignRun = await makeRun(other.workspace.id);
    detected = '00000000-0000-4000-8000-000000000001';
    activated = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    await app.dataSource.query(
      `INSERT INTO vulnerability_events
         (id, "vulnerabilityId", "workspaceId", type, "fromStatus", "toStatus", "jobHistoryId", "occurredAt", data)
       VALUES ($1, $3, $4, 'detected', NULL, 'new', $6, $8, '{"private":"fixture"}'),
              ($2, $3, $4, 'status_changed', 'new', 'active', $7, $8, NULL),
              (uuid_generate_v4(), $3, $5, 'detected', NULL, 'new', $7, $8, NULL),
              (uuid_generate_v4(), $3, $4, 'unpublished_type', NULL, NULL, NULL, $8, NULL)`,
      [
        detected,
        activated,
        finding,
        owner.workspace.id,
        other.workspace.id,
        run,
        foreignRun,
        occurredAt,
      ],
    );
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

  const expected = (jobHistoryId: string | null) => ({
    data: [
      {
        id: activated,
        type: 'status_changed',
        fromStatus: 'new',
        toStatus: 'active',
        occurredAt,
        jobHistoryId: null,
      },
      {
        id: detected,
        type: 'detected',
        fromStatus: null,
        toStatus: 'new',
        occurredAt,
        jobHistoryId,
      },
    ],
  });

  it('orders supported events by time and ID and exposes only scoped safe fields', async () => {
    await timeline(finding, owner.headers)
      .expect(200, expected(run))
      .expect('Cache-Control', 'private, no-store');
    await timeline(empty, owner.headers).expect(200, { data: [] });
  });

  it('does not reveal findings in another workspace', async () => {
    await timeline('invalid', owner.headers).expect(400);
    const missing = await timeline(randomUUID(), owner.headers).expect(404);
    const wrongWorkspace = await timeline(foreign, owner.headers).expect(404);
    expect(wrongWorkspace.body).toEqual(missing.body);
  });

  it('requires finding access and includes run IDs only with effective job access', async () => {
    const workspace = owner.workspace.id;
    const headers = wsHeaders(other.user.cookie, workspace);
    await timeline(finding, {}).expect(401);
    await timeline(finding, headers).expect(403);
    const member = await insertId(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)',
      [workspace, other.user.userId],
    );
    const role = await insertId(
      'INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)',
      [randomUUID(), ['job.read'], workspace],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [member, role],
    );
    await timeline(finding, headers).expect(403);
    for (const jobPermission of [null, 'job.read', 'job.write']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
        [
          ['vulnerability.read', ...(jobPermission ? [jobPermission] : [])],
          role,
        ],
      );
      await timeline(finding, headers).expect(
        200,
        expected(jobPermission ? run : null),
      );
    }
  });

  it('exposes dismissal and expiry history without private or malformed metadata', async () => {
    const own = await makeFinding(await makeAsset(owner.workspace.id));
    const expiresAt = '2026-03-14T12:30:00.000Z';
    const day = (index: number) => new Date(Date.parse(occurredAt) + index * 1_000);
    const add = (type: string, index: number, data: Record<string, unknown>, scope = owner.workspace.id) =>
      insertId(
        `INSERT INTO vulnerability_events
           ("vulnerabilityId", "workspaceId", type, "fromStatus", "toStatus",
            "jobHistoryId", "actorId", "occurredAt", data)
         VALUES ($1, $2, $3, 'private-state', 'private-state', $4, $5, $6, $7)`,
        [own, scope, type, run, owner.user.userId, day(index), data],
      );
    const dismissed = await add('dismissed', 1, {
      reason: 'risk_accepted',
      expiresAt: expiresAt.replace('Z', '+00:00'),
      comment: 'Private note',
    });
    const expired = await add('risk_expired', 2, {
      expiresAt,
      acceptedById: owner.user.userId,
    });
    const reopened = await add('reopened', 3, {
      previousReason: 'wont_fix',
      expiresAt,
    });
    const malformed = await add('dismissed', 4, {
      reason: 'risk_accepted',
      expiresAt: '2026-02-30T12:30:00Z',
    });
    const unknownReason = await add('reopened', 5, {
      previousReason: { comment: 'Private note' },
      expiresAt,
    });
    await add('dismissed', 6, { reason: 'false_positive' }, other.workspace.id);
    const row = (id: string, type: string, index: number) => ({
      id,
      type,
      occurredAt: day(index).toISOString(),
      fromStatus: null,
      toStatus: null,
      jobHistoryId: null,
    });
    await timeline(own, owner.headers).expect(200, {
      data: [
        row(unknownReason, 'reopened', 5),
        { ...row(malformed, 'dismissed', 4), dismissalReason: 'risk_accepted' },
        { ...row(reopened, 'reopened', 3), dismissalReason: 'wont_fix' },
        { ...row(expired, 'risk_expired', 2), dismissalReason: 'risk_accepted', expiresAt },
        { ...row(dismissed, 'dismissed', 1), dismissalReason: 'risk_accepted', expiresAt },
      ],
    });
  });

  it('bounds the result to the newest 500 events', async () => {
    await app.dataSource.query(
      `INSERT INTO vulnerability_events ("vulnerabilityId", "workspaceId", type, "occurredAt")
       SELECT $1, $2, 'detected', $3::timestamptz + position * interval '1 second'
       FROM generate_series(0, 500) AS position`,
      [empty, owner.workspace.id, occurredAt],
    );
    const response = await timeline(empty, owner.headers).expect(200);
    expect(response.body.data).toHaveLength(500);
    expect(response.body.data.at(-1).occurredAt).toBe(
      '2026-03-14T12:30:01.000Z',
    );
  });
});
