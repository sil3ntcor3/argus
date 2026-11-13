import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import * as request from 'supertest';
import { randomUUID } from 'node:crypto';

describe('Finding fix claims (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let findingId: string;
  const path = '/api/vulnerabilities/claim-fix';
  const insert = async (sql: string, values: unknown[]) => {
    const [{ id }] = await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values);
    return id;
  };
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'fix-claim');
    foreign = await createUserWithWorkspace(app.server, 'fix-claim-foreign');
    const target = await insert(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
      ['fix-claim.example.test', owner.workspace.id]);
    assetId = await insert(`INSERT INTO assets(value,"targetId") VALUES($1,$2)`, ['fix-claim.example.test', target]);
  });
  beforeEach(async () => {
    findingId = await insert(`INSERT INTO vulnerabilities(name,fingerprint,"assetId") VALUES($1,$2,$3)`,
      ['Fix claim fixture', randomUUID(), assetId]);
  });
  afterAll(async () => {
    if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner, foreign].filter(Boolean).map(value => value.workspace.id),
      userIds: [owner, foreign].filter(Boolean).map(value => value.user.userId),
    });
    await closeTestApp(app?.app);
  });

  it('deduplicates claims without closing findings or publishing private notes', async () => {
    const response = await request(app.server).post(path).set(owner.headers)
      .send({ vulnerabilityIds: [findingId, findingId], note: 'private repair note' }).expect(200);
    expect(response.body).toEqual({ updated: 1 });
    const [row] = await app.dataSource.query<{
      detectionStatus: string; fixedAt: Date | null; fixClaimedById: string; fixClaimedAt: Date;
    }[]>(`SELECT "detectionStatus","fixedAt","fixClaimedById","fixClaimedAt"
      FROM vulnerabilities WHERE id=$1`, [findingId]);
    expect(row).toMatchObject({ detectionStatus: 'new', fixedAt: null,
      fixClaimedById: owner.user.userId, fixClaimedAt: expect.any(Date) });
    const timeline = await request(app.server).get(`/api/vulnerabilities/${findingId}/timeline`)
      .set(owner.headers).expect(200);
    expect(timeline.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'fix_claimed', verification: 'not_verifiable_by_scan' }),
    ]));
    expect(JSON.stringify(timeline.body)).not.toContain('private repair note');
    expect(JSON.stringify(timeline.body)).not.toContain('actorId');
  });

  it('validates the entire workspace-scoped selection before any update', async () => {
    await request(app.server).post(path).set(owner.headers)
      .send({ vulnerabilityIds: [findingId, randomUUID()] }).expect(404);
    await request(app.server).post(path).set(foreign.headers)
      .send({ vulnerabilityIds: [findingId] }).expect(404);
    const [{ fixClaimedAt }] = await app.dataSource.query<{ fixClaimedAt: Date | null }[]>(
      'SELECT "fixClaimedAt" FROM vulnerabilities WHERE id=$1', [findingId]);
    expect(fixClaimedAt).toBeNull();
    await request(app.server).post(path).send({ vulnerabilityIds: [findingId] }).expect(401);
  });

  it.each(['fixed', 'archived', 'dismissed'])('rejects %s findings atomically', async state => {
    if (state === 'fixed') await app.dataSource.query(`UPDATE vulnerabilities SET "detectionStatus"='fixed'
      WHERE id=$1`, [findingId]);
    if (state === 'archived') await app.dataSource.query(`UPDATE vulnerabilities SET "isArchived"=true
      WHERE id=$1`, [findingId]);
    if (state === 'dismissed') await insert(`INSERT INTO vulnerability_dismissals
      ("vulnerabilityId","userId",reason) VALUES($1,$2,'false_positive')`, [findingId, owner.user.userId]);
    await request(app.server).post(path).set(owner.headers).send({ vulnerabilityIds: [findingId] }).expect(400);
    const [{ fixClaimedAt }] = await app.dataSource.query<{ fixClaimedAt: Date | null }[]>(
      'SELECT "fixClaimedAt" FROM vulnerabilities WHERE id=$1', [findingId]);
    expect(fixClaimedAt).toBeNull();
  });

  it.each([{ vulnerabilityIds: [] }, { vulnerabilityIds: ['invalid'] },
    { vulnerabilityIds: Array.from({ length: 1001 }, () => randomUUID()) },
    { vulnerabilityIds: undefined }, { note: 'x'.repeat(5001) }])('rejects invalid claims', async body => {
    await request(app.server).post(path).set(owner.headers)
      .send({ vulnerabilityIds: [findingId], ...body }).expect(400);
  });
});
