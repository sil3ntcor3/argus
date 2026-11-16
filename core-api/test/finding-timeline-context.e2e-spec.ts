import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { Severity } from '@/common/enums/enum';
import { VulnerabilityProposalService } from '@/modules/vulnerabilities/vulnerability-proposal.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { wsHeaders } from './helpers/auth';

describe('Finding timeline context and source presentation (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let asset: string;
  let role: string;
  let tool: string;
  let serial = 0;
  const headers = () => wsHeaders(other.user.cookie, owner.workspace.id);
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const finding = (review = 'approved', name = 'Timeline context') =>
    insert(
      `INSERT INTO vulnerabilities (name,severity,"assetId","reviewStatus") VALUES ($1,'high',$2,$3)`,
      [name, asset, review],
    );
  const event = (
    id: string,
    type: string,
    data: unknown = null,
    actor: string | null = owner.user.userId,
  ) =>
    insert(
      `INSERT INTO vulnerability_events ("vulnerabilityId","workspaceId",type,data,"actorId","occurredAt") VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        owner.workspace.id,
        type,
        data,
        actor,
        new Date(Date.UTC(2026, 10, 14, 12, 0, serial++)),
      ],
    );
  const timeline = async (id: string, auth = owner.headers) =>
    (
      await request(app.server)
        .get(`/api/vulnerabilities/${id}/timeline`)
        .set(auth)
        .expect(200)
    ).body.data as Record<string, unknown>[];
  const setPermissions = (permissions: string[]) =>
    app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [permissions, role],
    );
  const conversation = (
    user = owner.user.userId,
    workspace = owner.workspace.id,
  ) =>
    insert(
      'INSERT INTO agent_conversations (id,"workspaceId","createdBy","llmConfigId") VALUES ($1,$2,$3,$4)',
      [randomUUID(), workspace, user, randomUUID()],
    );

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'timeline-context');
    other = await createUserWithWorkspace(app.server, 'timeline-viewer');
    const target = await insert(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,\'DOMAIN\',$2)',
      [randomUUID() + '.example.test', owner.workspace.id],
    );
    asset = await insert(
      'INSERT INTO assets (value,"targetId") VALUES ($1,$2)',
      ['timeline.example.test', target],
    );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, other.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions ("workspaceId",name,permissions) VALUES ($1,$2,$3)',
      [owner.workspace.id, randomUUID(), ['vulnerability.read']],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
    tool = await insert(
      'INSERT INTO tools (name,categories,"logoUrl") VALUES ($1,$2,$3)',
      [
        'context-' + randomUUID(),
        JSON.stringify([{ name: 'vulnerabilities', targetTypes: ['DOMAIN'] }]),
        '/logos/context.png',
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
      if (tool)
        await app.dataSource.query('DELETE FROM tools WHERE id=$1', [tool]);
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('projects only actor id/name/image and leaves missing actors as null', async () => {
    const id = await finding();
    await event(id, 'detected', { private: 'hidden' });
    await event(id, 'detected', null, null);
    const rows = await timeline(id);
    expect(rows[0].actor).toBeNull();
    expect(rows[1].actor).toEqual({
      id: owner.user.userId,
      name: 'E2E timeline-context',
      image: null,
    });
    expect(Object.keys(rows[1].actor as object).sort()).toEqual([
      'id',
      'image',
      'name',
    ]);
    expect(JSON.stringify(rows)).not.toContain(owner.user.email);
    expect(JSON.stringify(rows)).not.toContain('hidden');
  });

  it('whitelists event-specific bounded text and rejects malformed context', async () => {
    const id = await finding();
    await event(id, 'dismissed', {
      comment: '<b>literal</b>',
      note: 'wrong event',
      private: 'hidden',
    });
    await event(id, 'risk_expired', {
      comment: 'x'.repeat(6000),
      acceptedById: owner.user.userId,
    });
    await event(id, 'fix_claimed', {
      note: 'Fix deployed',
      comment: 'wrong event',
    });
    await event(id, 'approved', {
      note: 'Reviewed',
      severity: 'critical',
      proposedSeverity: 'high',
      proof: 'hidden',
    });
    await event(id, 'rejected', {
      note: { private: 'hidden' },
      severity: 'critical',
    });
    await event(id, 'merged', {
      proposalName: 'SQL proposal',
      movedSources: 2,
      proposalId: randomUUID(),
    });
    await event(id, 'merged', { proposalName: [], movedSources: -1 });
    const rows = await timeline(id);
    expect(rows.map((row) => row.data)).toEqual([
      undefined,
      { proposalName: 'SQL proposal', movedSources: 2 },
      undefined,
      { note: 'Reviewed', severity: 'critical', proposedSeverity: 'high' },
      { note: 'Fix deployed' },
      { comment: 'x'.repeat(5000) },
      { comment: '<b>literal</b>' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('hidden');
    expect(JSON.stringify(rows)).not.toContain('wrong event');
  });

  it('shows only recognized scanner transition reasons', async () => {
    const id = await finding();
    await event(id, 'status_changed', { reason: 'detected_by_scan' });
    await event(id, 'status_changed', {
      reason: 'not_detected_by_covering_scan',
    });
    await event(id, 'status_changed', { reason: 'private-internal-reason' });
    expect((await timeline(id)).map((row) => row.data)).toEqual([
      undefined,
      { reason: 'not_detected_by_covering_scan' },
      { reason: 'detected_by_scan' },
    ]);
  });

  it('checks current agent access, conversation ownership/workspace and deletion before exposing context', async () => {
    const id = await finding();
    const own = await conversation();
    const foreign = await conversation(owner.user.userId, other.workspace.id);
    await event(id, 'proposed', {
      agentName: 'Pentest',
      agentConversationId: own,
    });
    await event(id, 'verified_by_ai', {
      agentName: 'Foreign',
      agentConversationId: foreign,
    });
    await event(id, 'proposed', {
      agentName: 'Malformed',
      agentConversationId: 'not-a-uuid',
    });
    expect((await timeline(id)).map((row) => row.data)).toEqual([
      undefined,
      undefined,
      { agentName: 'Pentest', agentConversationId: own },
    ]);
    await setPermissions(['vulnerability.read', 'agent.read']);
    expect(
      (await timeline(id, headers())).every((row) => row.data === undefined),
    ).toBe(true);
    const theirs = await conversation(other.user.userId);
    await event(id, 'verified_by_ai', {
      agentName: 'Reviewer assistant',
      agentConversationId: theirs,
    });
    expect((await timeline(id, headers()))[0].data).toEqual({
      agentName: 'Reviewer assistant',
      agentConversationId: theirs,
    });
    await setPermissions(['vulnerability.read']);
    expect((await timeline(id, headers()))[0].data).toBeUndefined();
    await setPermissions(['vulnerability.write', 'agent.write']);
    expect((await timeline(id, headers()))[0].data).toEqual({
      agentName: 'Reviewer assistant',
      agentConversationId: theirs,
    });
    await app.dataSource.query('DELETE FROM agent_conversations WHERE id=$1', [
      theirs,
    ]);
    expect((await timeline(id, headers()))[0].data).toBeUndefined();
  });

  it('resolves issue numbers from current scoped issues under effective workspace read', async () => {
    const id = await finding();
    const own = await insert(
      'INSERT INTO issues (title,"workspaceId",no) VALUES ($1,$2,$3)',
      ['Tracked', owner.workspace.id, 92001],
    );
    const foreign = await insert(
      'INSERT INTO issues (title,"workspaceId",no) VALUES ($1,$2,$3)',
      ['Foreign', other.workspace.id, 92001],
    );
    await event(id, 'issue_linked', {
      issueId: own,
      issueNo: 99999,
      private: 'hidden',
    });
    await event(id, 'issue_linked', { issueId: foreign, issueNo: 92001 });
    await event(id, 'issue_linked', { issueId: 'malformed' });
    expect((await timeline(id)).map((row) => row.data)).toEqual([
      undefined,
      undefined,
      { issueId: own, issueNo: 92001 },
    ]);
    await setPermissions(['vulnerability.read']);
    expect((await timeline(id, headers())).every((row) => !row.data)).toBe(
      true,
    );
    await setPermissions(['vulnerability.read', 'workspace.write']);
    expect((await timeline(id, headers()))[2].data).toEqual({
      issueId: own,
      issueNo: 92001,
    });
    await app.dataSource.query('DELETE FROM issues WHERE id=$1', [own]);
    expect((await timeline(id))[2].data).toBeUndefined();
  });

  it('records approval and rejection snapshots without reconstructing historic decisions', async () => {
    const approved = await finding('pending_review');
    await request(app.server)
      .post(`/api/vulnerabilities/${approved}/review/approve`)
      .set(owner.headers)
      .send({ severity: 'critical', note: 'Confirmed injection' })
      .expect(200);
    await app.dataSource.query(
      "UPDATE vulnerabilities SET severity='low',\"reviewNote\"='Changed later' WHERE id=$1",
      [approved],
    );
    const row = (await timeline(approved)).find(
      (row) => row.type === 'approved',
    );
    expect(row?.data).toEqual({
      note: 'Confirmed injection',
      severity: 'critical',
      proposedSeverity: 'high',
    });
    const rejected = await finding('pending_review');
    await request(app.server)
      .post(`/api/vulnerabilities/${rejected}/review/reject`)
      .set(owner.headers)
      .send({ note: 'Not reproducible' })
      .expect(200);
    expect((await timeline(rejected))[0].data).toEqual({
      note: 'Not reproducible',
    });
    await event(rejected, 'approved');
    expect(
      (await timeline(rejected)).find((row) => row.type === 'approved')?.data,
    ).toBeUndefined();
  });

  it('records AI proposal and verification context without exposing proof in the timeline', async () => {
    const conv = await conversation();
    const service = app.app.get(VulnerabilityProposalService);
    const input = {
      assetId: asset,
      name: 'AI context ' + randomUUID(),
      severity: Severity.HIGH,
      evidence: {
        requests: ['private-request'],
        responses: ['private-response'],
        baseline: 'private-baseline',
      },
    };
    const ctx = {
      workspaceId: owner.workspace.id,
      userId: owner.user.userId,
      conversationId: conv,
      agentName: 'Recorded agent',
    };
    const proposed = await service.propose(input, ctx);
    expect((await timeline(proposed.vulnerabilityId))[0].data).toEqual({
      agentName: 'Recorded agent',
      agentConversationId: conv,
    });
    await request(app.server)
      .post(`/api/vulnerabilities/${proposed.vulnerabilityId}/review/approve`)
      .set(owner.headers)
      .send({})
      .expect(200);
    await service.propose(
      { ...input, verifiesVulnerabilityId: proposed.vulnerabilityId },
      { ...ctx, agentName: 'Verifier' },
    );
    const rows = await timeline(proposed.vulnerabilityId);
    expect(rows.find((row) => row.type === 'verified_by_ai')?.data).toEqual({
      agentName: 'Verifier',
      agentConversationId: conv,
    });
    expect(rows.find((row) => row.type === 'proposed')?.data).toEqual({
      agentName: 'Recorded agent',
      agentConversationId: conv,
    });
    expect(JSON.stringify(rows)).not.toContain('private-request');
  });

  it('keeps merged proposal names and source counts after deleting the proposal', async () => {
    const proposal = await finding('pending_review', 'Original proposal');
    const target = await finding();
    await app.dataSource.query(
      'INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"toolId") VALUES ($1,\'tool\',$2)',
      [proposal, tool],
    );
    await request(app.server)
      .post(`/api/vulnerabilities/${proposal}/review/merge`)
      .set(owner.headers)
      .send({ targetVulnerabilityId: target })
      .expect(200);
    expect(
      (await timeline(target)).find((row) => row.type === 'merged')?.data,
    ).toEqual({ proposalName: 'Original proposal', movedSources: 1 });
    expect(
      await app.dataSource.query('SELECT id FROM vulnerabilities WHERE id=$1', [
        proposal,
      ]),
    ).toEqual([]);
  });

  it('adds only a nullable logo to source tool metadata and keeps summary rows compact', async () => {
    const id = await finding();
    await app.dataSource.query(
      'INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"toolId") VALUES ($1,\'tool\',$2)',
      [id, tool],
    );
    const detail = () =>
      request(app.server)
        .get(`/api/vulnerabilities/${id}`)
        .set(owner.headers)
        .expect(200);
    const source = (await detail()).body.sources[0];
    expect(source.tool).toEqual({
      id: tool,
      name: expect.stringMatching(/^context-/),
      logoUrl: '/logos/context.png',
    });
    await app.dataSource.query('UPDATE tools SET "logoUrl"=NULL WHERE id=$1', [
      tool,
    ]);
    expect((await detail()).body.sources[0].tool.logoUrl).toBeNull();
    const list = await request(app.server)
      .get('/api/vulnerabilities')
      .set(owner.headers)
      .query({ q: 'Timeline context' })
      .expect(200);
    const row = list.body.data.find((row: { id: string }) => row.id === id);
    expect(Object.keys(row.sources[0]).sort()).toEqual([
      'agentName',
      'kind',
      'toolName',
    ]);
  });
});
