import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { wsHeaders } from './helpers/auth';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';

describe('Resource discussion HTTP contracts (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let peer: typeof owner;
  let roleId: string;
  let issueId: string;
  let foreignIssueId: string;
  let findingId: string;
  let foreignFindingId: string;
  let publish: jest.SpyInstance<Promise<string | null>, Parameters<EventBridgeService['publishSafely']>>;
  const insert = async (sql: string, values: unknown[]) =>
    (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  const thread = (kind: 'issue' | 'vulnerability', id = kind === 'issue' ? issueId : findingId) =>
    `/api/${kind === 'issue' ? 'issues' : 'vulnerabilities'}/${id}/comments`;
  const mine = (kind: 'issue' | 'vulnerability') => thread(kind);
  const access = (permissions: string[]) => app.dataSource.query(
    'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [permissions, roleId]);
  const peerHeaders = () => wsHeaders(peer.user.cookie, owner.workspace.id);
  const create = (kind: 'issue' | 'vulnerability', content = 'Discussion fixture', headers = owner.headers,
    repCommentId?: string) => request(app.server).post(mine(kind)).set(headers).send({ content, repCommentId });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'discussion-owner');
    peer = await createUserWithWorkspace(app.server, 'discussion-peer');
    const member = await insert('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, peer.user.userId]);
    roleId = await insert('INSERT INTO workspace_permissions(name,permissions,"workspaceId") VALUES($1,$2,$3)',
      ['Discussion fixture', ['*'], owner.workspace.id]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',
      [member, roleId]);
    const seed = async (workspaceId: string) => {
      const issue = await insert('INSERT INTO issues(title,"workspaceId") VALUES($1,$2)', ['Discussion fixture', workspaceId]);
      const target = await insert(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
        [randomUUID() + '.example.test', workspaceId]);
      const asset = await insert('INSERT INTO assets(value,"targetId") VALUES($1,$2)', [randomUUID(), target]);
      const finding = await insert('INSERT INTO vulnerabilities(name,"assetId") VALUES($1,$2)', ['Discussion finding', asset]);
      return { issue, finding };
    };
    const own = await seed(owner.workspace.id);
    const foreign = await seed(peer.workspace.id);
    issueId = own.issue; findingId = own.finding;
    foreignIssueId = foreign.issue; foreignFindingId = foreign.finding;
    publish = jest.spyOn(app.app.get(EventBridgeService), 'publishSafely').mockResolvedValue(null);
  });
  beforeEach(async () => {
    await access(['*']);
    publish.mockClear();
    await app.dataSource.query('UPDATE comments SET "repCommentId"=NULL WHERE "issueId"=ANY($1::uuid[]) OR "vulnerabilityId"=ANY($2::uuid[])',
      [[issueId, foreignIssueId], [findingId, foreignFindingId]]);
    await app.dataSource.query('DELETE FROM comments WHERE "issueId"=ANY($1::uuid[]) OR "vulnerabilityId"=ANY($2::uuid[])',
      [[issueId, foreignIssueId], [findingId, foreignFindingId]]);
  });
  afterAll(async () => {
    publish?.mockRestore();
    if (app) {
      await app.dataSource.query('UPDATE comments SET "repCommentId"=NULL WHERE "issueId"=ANY($1::uuid[]) OR "vulnerabilityId"=ANY($2::uuid[])',
        [[issueId, foreignIssueId].filter(Boolean), [findingId, foreignFindingId].filter(Boolean)]);
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner, peer].filter(Boolean).map(value => value.workspace.id),
        userIds: [owner, peer].filter(Boolean).map(value => value.user.userId),
      });
    }
    await closeTestApp(app?.app);
  });

  it.each(['issue', 'vulnerability'] as const)('creates and paginates a %s thread with the approved DTO', async kind => {
    const first = await create(kind, 'First comment').expect(201);
    expect(first.body).toEqual({
      id: expect.any(String), content: 'First comment', type: 'content',
      issueId: kind === 'issue' ? issueId : null,
      vulnerabilityId: kind === 'vulnerability' ? findingId : null,
      isCanEdit: true, isCanDelete: true, createdAt: expect.any(String), updatedAt: expect.any(String),
      author: { id: owner.user.userId, name: 'E2E discussion-owner', image: null }, repComment: null,
    });
    const second = await create(kind, 'Second comment').expect(201);
    // Equal timestamps must not duplicate or skip records between pages.
    await app.dataSource.query('UPDATE comments SET "createdAt"=$1 WHERE id=ANY($2::uuid[])',
      [new Date('2026-01-01T00:00:00Z'), [first.body.id, second.body.id]]);
    const ids = [first.body.id, second.body.id].sort();
    for (const [page, id] of ids.entries()) {
      const response = await request(app.server).get(mine(kind)).set(owner.headers).query({ page: page + 1, limit: 1 }).expect(200);
      expect(response.body).toMatchObject({ total: 2, page: page + 1, limit: 1, data: [{ id }], hasNextPage: page === 0 });
      expect(JSON.stringify(response.body)).not.toMatch(/email|createdById|repCommentId|deletedAt/);
    }
  });

  it.each(['issue', 'vulnerability'] as const)('edits, replies and soft-deletes a %s comment', async kind => {
    const parent = await create(kind, 'p'.repeat(220)).expect(201);
    const reply = await create(kind, 'Reply', owner.headers, parent.body.id).expect(201);
    expect(reply.body.repComment).toMatchObject({ id: parent.body.id, snippet: 'p'.repeat(200), deleted: false });
    const edited = await request(app.server).patch('/api/comments/' + reply.body.id).set(owner.headers)
      .send({ content: 'Edited reply' }).expect(200);
    expect(edited.body.content).toBe('Edited reply');
    await request(app.server).delete('/api/comments/' + parent.body.id).set(owner.headers).expect(200,
      { message: 'Comment deleted successfully' });
    const list = await request(app.server).get(mine(kind)).set(owner.headers).expect(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: reply.body.id,
      repComment: expect.objectContaining({ id: parent.body.id, deleted: true, snippet: '' }) })]);
    expect((await app.dataSource.query('SELECT "deletedAt" FROM comments WHERE id=$1', [parent.body.id]))[0].deletedAt).toBeTruthy();
    await create(kind, 'Reply to deleted', owner.headers, parent.body.id).expect(400);
    await request(app.server).patch('/api/comments/' + parent.body.id).set(owner.headers).send({ content: 'No' }).expect(404);
    await request(app.server).delete('/api/comments/' + parent.body.id).set(owner.headers).expect(404);
  });

  it.each(['issue', 'vulnerability'] as const)('checks %s read/write permissions and revoked author access', async kind => {
    const domain = kind === 'issue' ? 'workspace' : 'vulnerability';
    await access([]);
    await request(app.server).get(mine(kind)).set(peerHeaders()).expect(403);
    await create(kind, 'Denied', peerHeaders()).expect(403);
    await access([domain + '.read']);
    await request(app.server).get(mine(kind)).set(peerHeaders()).expect(200);
    await create(kind, 'Denied', peerHeaders()).expect(403);
    await access([domain + '.write']);
    await request(app.server).get(mine(kind)).set(peerHeaders()).expect(200);
    const authored = await create(kind, 'Peer author', peerHeaders()).expect(201);
    await access([domain + '.read']);
    await request(app.server).patch('/api/comments/' + authored.body.id).set(peerHeaders()).send({ content: 'Revoked' }).expect(403);
    await request(app.server).delete('/api/comments/' + authored.body.id).set(peerHeaders()).expect(403);
    await access([domain + '.write']);
    await request(app.server).patch('/api/comments/' + authored.body.id).set(peerHeaders()).send({ content: 'Allowed' }).expect(200);
    await request(app.server).delete('/api/comments/' + authored.body.id).set(peerHeaders()).expect(200);
  });

  it.each(['issue', 'vulnerability'] as const)('rejects nonauthors and system %s mutations', async kind => {
    const row = await create(kind).expect(201);
    await request(app.server).patch('/api/comments/' + row.body.id).set(peerHeaders()).send({ content: 'Not my comment' }).expect(403);
    await request(app.server).delete('/api/comments/' + row.body.id).set(peerHeaders()).expect(403);
    await app.dataSource.query('UPDATE comments SET "isCanEdit"=false,"isCanDelete"=false WHERE id=$1', [row.body.id]);
    await request(app.server).patch('/api/comments/' + row.body.id).set(owner.headers).send({ content: 'System' }).expect(403);
    await request(app.server).delete('/api/comments/' + row.body.id).set(owner.headers).expect(403);
  });

  it.each(['issue', 'vulnerability'] as const)('validates %s input, IDs and authentication', async kind => {
    for (const content of [undefined, null, '', 123, 'x'.repeat(10001)])
      await request(app.server).post(mine(kind)).set(owner.headers).send({ content }).expect(400);
    await create(kind, 'x'.repeat(10000)).expect(201);
    await create(kind, 'Bad reply', owner.headers, 'invalid').expect(400);
    await create(kind, 'Missing reply', owner.headers, randomUUID()).expect(400);
    await request(app.server).get(thread(kind, 'invalid')).set(owner.headers).expect(400);
    await request(app.server).get(mine(kind)).set(owner.headers).query({ page: 0 }).expect(400);
    await request(app.server).get(mine(kind)).expect(401);
    await request(app.server).post(mine(kind)).send({ content: 'Anonymous' }).expect(401);
    await request(app.server).patch('/api/comments/invalid').set(owner.headers).send({ content: 'Invalid' }).expect(400);
    await request(app.server).delete('/api/comments/invalid').set(owner.headers).expect(400);
  });

  it.each(['issue', 'vulnerability'] as const)('hides foreign and missing %s subjects', async kind => {
    const foreign = kind === 'issue' ? foreignIssueId : foreignFindingId;
    for (const id of [foreign, randomUUID()]) {
      await request(app.server).get(thread(kind, id)).set(owner.headers).expect(404);
      await request(app.server).post(thread(kind, id)).set(owner.headers).send({ content: 'Hidden' }).expect(404);
    }
    const row = await create(kind).expect(201);
    const hidden = await request(app.server).patch('/api/comments/' + row.body.id).set(peer.headers).send({ content: 'Foreign workspace' }).expect(404);
    const missing = await request(app.server).patch('/api/comments/' + randomUUID()).set(peer.headers).send({ content: 'Missing' }).expect(404);
    expect(hidden.body.message).toBe(missing.body.message);
    await request(app.server).delete('/api/comments/' + row.body.id).set(peer.headers).expect(404);
  });

  it.each(['issue', 'vulnerability'] as const)('removes the thread when its %s subject is deleted', async kind => {
    const subject = kind === 'issue'
      ? await insert('INSERT INTO issues(title,"workspaceId") VALUES($1,$2)', ['Disposable subject', owner.workspace.id])
      : await insert('INSERT INTO vulnerabilities(name,"assetId") SELECT $1,"assetId" FROM vulnerabilities WHERE id=$2',
        ['Disposable subject', findingId]);
    const row = await request(app.server).post(thread(kind, subject)).set(owner.headers).send({ content: 'Cascade fixture' }).expect(201);
    await app.dataSource.query(`DELETE FROM ${kind === 'issue' ? 'issues' : 'vulnerabilities'} WHERE id=$1`, [subject]);
    await request(app.server).get(thread(kind, subject)).set(owner.headers).expect(404);
    await request(app.server).delete('/api/comments/' + row.body.id).set(owner.headers).expect(404);
  });

  it('rejects and redacts cross-subject replies, including stored stale pointers', async () => {
    const finding = await create('vulnerability', 'Private finding body').expect(201);
    await create('issue', 'Cross-subject', owner.headers, finding.body.id).expect(400);
    const issue = await create('issue', 'Issue body').expect(201);
    await app.dataSource.query('UPDATE comments SET "repCommentId"=$1 WHERE id=$2', [finding.body.id, issue.body.id]);
    const list = await request(app.server).get(mine('issue')).set(owner.headers).expect(200);
    expect(list.body.data[0].repComment).toBeNull();
    expect(JSON.stringify(list.body)).not.toContain('Private finding body');
    expect(JSON.stringify(list.body)).not.toContain(finding.body.id);
  });

  it('returns deleted authors as null and publishes redacted creation/update events', async () => {
    const finding = await create('vulnerability', 'Private event body').expect(201);
    const createdCall = publish.mock.calls.find(([event]) => typeof event !== 'string' && event.name === 'vulnerability.comment.created');
    expect(createdCall?.[1]).toMatchObject({ workspaceId: owner.workspace.id,
      resourceType: 'vulnerability', resourceId: findingId, metadata: { commentId: finding.body.id } });
    expect(JSON.stringify(createdCall)).not.toContain('Private event body');
    expect(JSON.stringify(createdCall)).not.toContain(owner.user.email);
    const issue = await create('issue', 'Private issue body').expect(201);
    await request(app.server).patch('/api/comments/' + issue.body.id).set(owner.headers).send({ content: 'Changed' }).expect(200);
    expect(publish.mock.calls.map(([event]) => typeof event === 'string' ? event : event.name)).toEqual(
      expect.arrayContaining(['issue.comment.created', 'issue.comment.updated']));
    await app.dataSource.query('UPDATE comments SET "createdById"=NULL WHERE id=$1', [finding.body.id]);
    const list = await request(app.server).get(mine('vulnerability')).set(owner.headers).expect(200);
    expect(list.body.data[0].author).toBeNull();
  });
});
