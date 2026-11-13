import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { IssueComment } from '@/modules/issues/entities/issue-comment.entity';
import { IssuesService } from '@/modules/issues/issues.service';
import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { randomUUID } from 'node:crypto';

describe('Resource comment storage (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreign: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let issueId: string;
  let findingId: string;
  let assetId: string;
  const insert = async (sql: string, values: unknown[]) =>
    (await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', values))[0].id;
  const save = (subject: { issueId?: string | null; vulnerabilityId?: string | null }) =>
    app.dataSource.getRepository(IssueComment).save(Object.assign(
      new IssueComment(), { content: 'Private storage fixture', createdById: owner.user.userId }, subject,
    ));
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'resource-comment-storage');
    foreign = await createUserWithWorkspace(app.server, 'resource-comment-foreign');
    issueId = await insert('INSERT INTO issues(title,"workspaceId","createdById") VALUES($1,$2,$3)',
      ['Legacy issue fixture', owner.workspace.id, owner.user.userId]);
    const target = await insert(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2)`,
      [randomUUID() + '.example.test', owner.workspace.id]);
    assetId = await insert('INSERT INTO assets(value,"targetId") VALUES($1,$2)', [randomUUID(), target]);
    findingId = await insert('INSERT INTO vulnerabilities(name,"assetId") VALUES($1,$2)', [randomUUID(), assetId]);
  });
  afterAll(async () => {
    if (app && issueId) await app.dataSource.query(
      'UPDATE comments SET "repCommentId"=NULL WHERE "issueId"=$1', [issueId]);
    if (app) await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner, foreign].filter(Boolean).map(value => value.workspace.id),
      userIds: [owner, foreign].filter(Boolean).map(value => value.user.userId),
    });
    await closeTestApp(app?.app);
  });

  it('stores a finding-only comment without requiring an issue', async () => {
    await expect(save({ vulnerabilityId: findingId })).resolves.toMatchObject({ content: 'Private storage fixture' });
  });

  it.each([{}, { issueId: null, vulnerabilityId: null }])('rejects a comment without a subject: %j', async subject => {
    await expect(save(subject)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects both subjects and dangling finding references', async () => {
    await expect(save({ issueId, vulnerabilityId: findingId })).rejects.toMatchObject({ code: '23514' });
    await expect(save({ vulnerabilityId: randomUUID() })).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the new subject private in ordinary entity and legacy issue reads', async () => {
    const row = await save({ vulnerabilityId: findingId });
    const entity = await app.dataSource.getRepository(IssueComment).findOneByOrFail({ id: row.id });
    expect(Reflect.get(entity, 'vulnerabilityId')).toBeUndefined();
    expect(JSON.stringify(entity)).not.toContain('vulnerabilityId');
    const service = app.app.get(IssuesService);
    const legacy = await service.createComment({ content: 'Legacy operations still work' }, issueId,
      owner.user.userId, owner.workspace.id);
    const result = await service.getCommentsByIssueId(issueId, new GetManyBaseQueryParams(), owner.workspace.id);
    expect(result.data.map(comment => comment.id)).toContain(legacy.id);
    expect(result.data.map(comment => comment.id)).not.toContain(row.id);
    expect(JSON.stringify(result)).not.toContain('vulnerabilityId');
  });

  it('preserves legacy replies, soft deletion, authorship and workspace scoping', async () => {
    const service = app.app.get(IssuesService);
    const parent = await service.createComment({ content: 'Parent fixture' }, issueId, owner.user.userId, owner.workspace.id);
    const reply = await service.createComment({ content: 'Reply fixture', repCommentId: parent.id }, issueId,
      owner.user.userId, owner.workspace.id);
    await expect(service.updateCommentById(parent.id, { content: 'Unauthorized' }, foreign.user.userId, owner.workspace.id))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.updateCommentById(parent.id, { content: 'Foreign scope' }, owner.user.userId, foreign.workspace.id))
      .rejects.toMatchObject({ status: 404 });
    await service.updateCommentById(reply.id, { content: 'Updated reply' }, owner.user.userId, owner.workspace.id);
    await service.deleteCommentById(parent.id, owner.user.userId, owner.workspace.id);
    const result = await service.getCommentsByIssueId(issueId, new GetManyBaseQueryParams(), owner.workspace.id);
    expect(result.data.find(comment => comment.id === reply.id)).toMatchObject({ content: 'Updated reply',
      repComment: { id: parent.id, content: 'The comment has been deleted.' } });
    expect(result.data.map(comment => comment.id)).not.toContain(parent.id);
  });

  it('does not let legacy issue operations edit or delete finding comments', async () => {
    const row = await save({ vulnerabilityId: findingId });
    const service = app.app.get(IssuesService);
    await expect(service.updateCommentById(row.id, { content: 'Wrong subject' }, owner.user.userId, owner.workspace.id))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.deleteCommentById(row.id, owner.user.userId, owner.workspace.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects private finding replies and redacts pre-existing cross-subject references', async () => {
    const privateComment = await save({ vulnerabilityId: findingId });
    const service = app.app.get(IssuesService);
    await expect(service.createComment({ content: 'Attempted quote', repCommentId: privateComment.id },
      issueId, owner.user.userId, owner.workspace.id)).rejects.toMatchObject({ status: 404 });
    const stale = await app.dataSource.getRepository(IssueComment).save(Object.assign(new IssueComment(), {
      content: 'Stored legacy reference', issueId, repCommentId: privateComment.id, createdById: owner.user.userId,
    }));
    const result = await service.getCommentsByIssueId(issueId, new GetManyBaseQueryParams(), owner.workspace.id);
    expect(result.data.find(comment => comment.id === stale.id)).toMatchObject({ repComment: null, repCommentId: null });
    expect(JSON.stringify(result)).not.toContain('Private storage fixture');
  });

  it('preserves creator/reply foreign keys and cascades with the finding', async () => {
    const subject = await insert('INSERT INTO vulnerabilities(name,"assetId") VALUES($1,$2)', [randomUUID(), assetId]);
    const parent = await save({ vulnerabilityId: subject });
    const reply = await insert('INSERT INTO comments(content,"vulnerabilityId","repCommentId") VALUES($1,$2,$3)',
      ['Finding reply', subject, parent.id]);
    await expect(app.dataSource.query('UPDATE comments SET "createdById"=$1 WHERE id=$2', [randomUUID(), parent.id]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(app.dataSource.query('UPDATE comments SET "repCommentId"=$1 WHERE id=$2', [randomUUID(), reply]))
      .rejects.toMatchObject({ code: '23503' });
    await app.dataSource.query('DELETE FROM vulnerabilities WHERE id=$1', [subject]);
    const [{ count }] = await app.dataSource.query<{ count: number }[]>(
      'SELECT COUNT(*)::int AS count FROM comments WHERE id=ANY($1::uuid[])', [[parent.id, reply]]);
    expect(count).toBe(0);
  });
});
