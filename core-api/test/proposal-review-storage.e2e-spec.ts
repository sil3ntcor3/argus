import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { randomUUID } from 'node:crypto';
import { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Proposal review storage (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let asset: string;
  const insert = async (sql: string, values: unknown[] = []) =>
    (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'proposal-storage');
    const target = await insert('INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)', ['proposal.example.test', 'DOMAIN', owner.workspace.id]);
    asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', ['proposal.example.test', target]);
  });
  afterAll(async () => {
    if (app) await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id].filter(Boolean), userIds: [owner?.user.userId].filter(Boolean) });
    await closeTestApp(app?.app);
  });
  it('defaults legacy-compatible findings to approved scanner discoveries and hides persistence fields', async () => {
    const id = await insert('INSERT INTO vulnerabilities (name,fingerprint,"assetId") VALUES ($1,$2,$3)', ['Legacy-compatible', randomUUID(), asset]);
    const [row] = await app.dataSource.query('SELECT "reviewStatus","discoveredBy","reviewedAt","reviewNote","reviewedById" FROM vulnerabilities WHERE id=$1', [id]);
    expect(row).toEqual({ reviewStatus: 'approved', discoveredBy: 'tool', reviewedAt: null, reviewNote: null, reviewedById: null });
    const entity = await app.dataSource.getRepository(Vulnerability).findOneByOrFail({ id });
    for (const key of Object.keys(row)) expect(Reflect.get(entity, key)).toBeUndefined();
  });
  it('preserves attached proof and review decisions after actor and conversation deletion', async () => {
    const actor = await insert('INSERT INTO users (name,email,"emailVerified") VALUES ($1,$2,true)', ['Review actor', `${randomUUID()}@example.test`]);
    const conversation = randomUUID();
    await app.dataSource.query('INSERT INTO agent_conversations (id,"workspaceId","createdBy","llmConfigId") VALUES ($1,$2,$3,$4)', [conversation, owner.workspace.id, owner.user.userId, randomUUID()]);
    const id = await insert(`INSERT INTO vulnerabilities (name,fingerprint,"assetId","reviewStatus","discoveredBy","reviewedById","reviewedAt","reviewNote") VALUES ($1,$2,$3,'rejected','ai',$4,$5,$6)`, ['AI proposal', randomUUID(), asset, actor, '2026-11-13T10:00:00+05:30', 'Not reproducible']);
    const evidence = { requests: ['GET /test'], responses: ['200 OK'], baseline: 'GET /baseline' };
    const source = await insert(`INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"agentConversationId","agentName","toolCallIds",evidence,"createdById") VALUES ($1,'ai_agent',$2,$3,$4,$5,$6)`, [id, conversation, 'Argus', ['call-1'], evidence, actor]);
    await app.dataSource.query('DELETE FROM agent_conversations WHERE id=$1', [conversation]);
    await app.dataSource.query('DELETE FROM users WHERE id=$1', [actor]);
    expect((await app.dataSource.query('SELECT "reviewStatus","reviewedById","reviewNote","reviewedAt" FROM vulnerabilities WHERE id=$1', [id]))[0]).toEqual({ reviewStatus: 'rejected', reviewedById: null, reviewNote: 'Not reproducible', reviewedAt: new Date('2026-11-13T04:30:00Z') });
    expect((await app.dataSource.query('SELECT "agentConversationId","createdById","agentName","toolCallIds",evidence FROM vulnerability_sources WHERE id=$1', [source]))[0]).toEqual({ agentConversationId: null, createdById: null, agentName: 'Argus', toolCallIds: ['call-1'], evidence });
  });
  it('retains scanner run uniqueness, cleanup index and the new review index', async () => {
    const indexes = await app.dataSource.query<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE tablename IN ('vulnerabilities','vulnerability_sources')`);
    expect(indexes.map(row => row.indexname)).toEqual(expect.arrayContaining(['UQ_vuln_source_finding_kind_run', 'IDX_vuln_source_run', 'IDX_vuln_reviewStatus']));
  });
});
