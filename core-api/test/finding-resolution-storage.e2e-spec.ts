import { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

const fields = [
  'lastSeenJobHistoryId',
  'fixedByJobHistoryId',
  'fixClaimedAt',
  'fixClaimedById',
  'dueAt',
];

describe('Finding resolution storage (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let findingId: string;
  const runIds: string[] = [];
  const userIds: string[] = [];
  const insert = async (sql: string, values: unknown[] = []) => {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };
  const read = async () => {
    const [row] = await app.dataSource.query<Record<string, unknown>[]>(
      `SELECT ${fields.map((field) => `"${field}"`).join(', ')} FROM vulnerabilities WHERE id = $1`,
      [findingId],
    );
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'resolution-storage');
    const targetId = await insert(
      `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
      ['resolution.example.test', owner.workspace.id],
    );
    assetId = await insert(
      `INSERT INTO assets (value, "targetId") VALUES ($1, $2)`,
      ['resolution.example.test', targetId],
    );
  });

  beforeEach(async () => {
    findingId = await insert(
      `INSERT INTO vulnerabilities (name, fingerprint, "assetId") VALUES ($1, $2, $3)`,
      ['Resolution storage finding', randomUUID(), assetId],
    );
  });

  afterAll(async () => {
    if (app) {
      await app.dataSource.query(
        'DELETE FROM job_histories WHERE id = ANY($1::uuid[])',
        [runIds],
      );
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id].filter(Boolean),
        userIds: [...userIds, owner?.user.userId].filter(Boolean),
      });
    }
    await closeTestApp(app?.app);
  });

  it('leaves newly inserted findings unattributed by default', async () => {
    expect(await read()).toEqual(
      Object.fromEntries(fields.map((field) => [field, null])),
    );
  });

  it.each(['lastSeenJobHistoryId', 'fixedByJobHistoryId', 'fixClaimedById'])(
    'rejects a nonexistent reference in %s without changing the finding',
    async (field) => {
      await expect(
        app.dataSource.query(
          `UPDATE vulnerabilities SET "${field}" = $1 WHERE id = $2`,
          [randomUUID(), findingId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await read()).toEqual(
        Object.fromEntries(fields.map((name) => [name, null])),
      );
    },
  );

  it('retains the finding and exact UTC dates when its referenced run and user are deleted', async () => {
    const runId = await insert(
      `INSERT INTO job_histories ("jobHistoryName") VALUES ($1)`,
      ['Resolution provenance'],
    );
    runIds.push(runId);
    const actorId = await insert(
      `INSERT INTO users (name, email, "emailVerified") VALUES ($1, $2, true)`,
      ['Resolution actor', `${randomUUID()}@example.test`],
    );
    userIds.push(actorId);
    await app.dataSource.query(
      `UPDATE vulnerabilities SET "lastSeenJobHistoryId" = $1, "fixedByJobHistoryId" = $1,
       "fixClaimedById" = $2, "fixClaimedAt" = $3, "dueAt" = $4 WHERE id = $5`,
      [
        runId,
        actorId,
        '2026-11-12T13:00:00+05:30',
        '2026-11-20T10:00:00-07:00',
        findingId,
      ],
    );
    await app.dataSource.query('DELETE FROM job_histories WHERE id = $1', [runId]);
    await app.dataSource.query('DELETE FROM users WHERE id = $1', [actorId]);
    const row = await read();
    expect(row).toEqual({
      lastSeenJobHistoryId: null,
      fixedByJobHistoryId: null,
      fixClaimedById: null,
      fixClaimedAt: new Date('2026-11-12T07:30:00Z'),
      dueAt: new Date('2026-11-20T17:00:00Z'),
    });
  });

  it('keeps populated provenance private in entity reads and authenticated list/detail responses', async () => {
    const runId = await insert(
      `INSERT INTO job_histories ("jobHistoryName") VALUES ($1)`,
      ['Private resolution provenance'],
    );
    runIds.push(runId);
    await app.dataSource.query(
      `UPDATE vulnerabilities SET "lastSeenJobHistoryId" = $1, "fixedByJobHistoryId" = $1,
       "fixClaimedById" = $2, "fixClaimedAt" = now(), "dueAt" = now() WHERE id = $3`,
      [runId, owner.user.userId, findingId],
    );
    const entity = await app.dataSource
      .getRepository(Vulnerability)
      .findOneByOrFail({ id: findingId });
    // SWC may emit undefined class fields; neither values nor JSON may leak.
    for (const field of fields) {
      expect(Reflect.get(entity, field)).toBeUndefined();
      expect(JSON.stringify(entity)).not.toContain(`"${field}"`);
    }
    for (const path of [
      `/api/vulnerabilities/${findingId}`,
      '/api/vulnerabilities',
    ]) {
      const response = await request(app.server)
        .get(path)
        .set(owner.headers)
        .expect(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).toContain(findingId);
      for (const field of [
        ...fields,
        'lastSeenJobHistory',
        'fixedByJobHistory',
        'fixClaimedBy',
      ]) {
        expect(serialized).not.toContain(`"${field}"`);
      }
      await request(app.server).get(path).expect(401);
    }
  });
});
