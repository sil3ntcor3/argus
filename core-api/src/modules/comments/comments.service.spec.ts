import { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { IssueCommentType } from '@/common/enums/enum';
import type { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { IssueComment } from '@/modules/issues/entities/issue-comment.entity';
import type { Issue } from '@/modules/issues/entities/issue.entity';
import type { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { CommentsService } from './comments.service';

describe('CommentsService', () => {
  const actor = randomUUID(), workspace = randomUUID(), subjectId = randomUUID();
  const subject = { kind: 'vulnerability', id: subjectId } as const;
  let row: IssueComment;
  const query = {
    withDeleted: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(), select: jest.fn(), addSelect: jest.fn(),
    where: jest.fn(), andWhere: jest.fn(), orderBy: jest.fn(), addOrderBy: jest.fn(), skip: jest.fn(), take: jest.fn(),
    getManyAndCount: jest.fn(), getOne: jest.fn(), getExists: jest.fn(),
  };
  const comments = { createQueryBuilder: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn(),
    update: jest.fn(), softDelete: jest.fn() };
  const issues = { existsBy: jest.fn() };
  const findings = { createQueryBuilder: jest.fn() };
  const events = { publishSafely: jest.fn() };
  let service: CommentsService;
  beforeEach(() => {
    jest.resetAllMocks();
    for (const method of Object.values(query)) method.mockReturnValue(query);
    row = Object.assign(new IssueComment(), {
      id: randomUUID(), content: 'Private discussion', issueId: null, vulnerabilityId: subjectId,
      type: IssueCommentType.CONTENT, createdById: actor, isCanEdit: true, isCanDelete: true,
      createdAt: new Date(), updatedAt: new Date(),
      createdBy: { id: actor, name: 'Author', image: null, email: 'hidden@example.test', role: 'admin' },
    });
    query.getOne.mockImplementation(() => Promise.resolve(row));
    query.getManyAndCount.mockImplementation(() => Promise.resolve([[row], 1]));
    query.getExists.mockResolvedValue(true); issues.existsBy.mockResolvedValue(true);
    comments.createQueryBuilder.mockReturnValue(query); findings.createQueryBuilder.mockReturnValue(query);
    comments.findOne.mockResolvedValue({ id: randomUUID() });
    comments.create.mockImplementation((input: Partial<IssueComment>) => Object.assign(new IssueComment(), row, input));
    comments.save.mockImplementation((input: IssueComment) => { row = input; return Promise.resolve(row); });
    comments.update.mockImplementation((_id: string, input: Partial<IssueComment>) => { Object.assign(row, input); return Promise.resolve({ affected: 1 }); });
    comments.softDelete.mockResolvedValue({ affected: 1 }); events.publishSafely.mockResolvedValue(null);
    service = new CommentsService(comments as unknown as Repository<IssueComment>, issues as unknown as Repository<Issue>,
      findings as unknown as Repository<Vulnerability>, events as unknown as EventBridgeService);
  });

  it.each(['issue', 'vulnerability'] as const)('does not read or write an inaccessible %s discussion', async kind => {
    issues.existsBy.mockResolvedValue(false); query.getExists.mockResolvedValue(false);
    await expect(service.list({ kind, id: subjectId }, new GetManyBaseQueryParams(), workspace)).rejects.toMatchObject({ status: 404 });
    await expect(service.create({ kind, id: subjectId }, { content: 'Denied' }, actor, workspace)).rejects.toMatchObject({ status: 404 });
    expect(comments.save).not.toHaveBeenCalled(); expect(events.publishSafely).not.toHaveBeenCalled();
  });

  it.each(['issue', 'vulnerability'] as const)('creates a %s reply and publishes IDs without content or user secrets', async kind => {
    if (kind === 'issue') { row.issueId = subjectId; row.vulnerabilityId = null; }
    const result = await service.create({ kind, id: subjectId }, { content: 'Secret comment', repCommentId: randomUUID() }, actor, workspace);
    expect(result).toMatchObject({ content: 'Secret comment', author: { id: actor, name: 'Author', image: null } });
    expect(events.publishSafely.mock.calls[0][0]).toMatchObject({ name: kind + '.comment.created' });
    const serialized = JSON.stringify(events.publishSafely.mock.calls[0]);
    expect(serialized).toContain(row.id); expect(serialized).not.toContain('Secret comment');
    expect(serialized).not.toContain('hidden@example.test');
    expect(JSON.stringify(result)).not.toMatch(/email|role|createdById/);
  });

  it('rejects an invalid reply without saving or publishing', async () => {
    comments.findOne.mockResolvedValue(null);
    await expect(service.create(subject, { content: 'Denied reply', repCommentId: randomUUID() }, actor, workspace))
      .rejects.toMatchObject({ status: 400 });
    expect(comments.save).not.toHaveBeenCalled(); expect(events.publishSafely).not.toHaveBeenCalled();
  });

  it('maps missing authors and deleted replies without exposing the parent body', async () => {
    row.createdBy = null as unknown as IssueComment['createdBy'];
    row.repComment = Object.assign(new IssueComment(), { id: randomUUID(), content: 'Private deleted body', deletedAt: new Date() });
    const result = await service.list(subject, new GetManyBaseQueryParams(), workspace);
    expect(result.data[0]).toMatchObject({ author: null, repComment: { deleted: true, snippet: '', author: null } });
    expect(JSON.stringify(result)).not.toContain('Private deleted body');
    row.repComment.deletedAt = null as unknown as Date;
    row.repComment.content = 'x'.repeat(220);
    const live = await service.list(subject, new GetManyBaseQueryParams(), workspace);
    expect(live.data[0].repComment?.snippet).toBe('x'.repeat(200));
  });

  it.each(['issue', 'vulnerability'] as const)('requires the current %s write permission even for the author', async kind => {
    if (kind === 'issue') { row.issueId = subjectId; row.vulnerabilityId = null; }
    await expect(service.update(row.id, { content: 'Denied' }, actor, workspace, [kind === 'issue' ? 'workspace.read' : 'vulnerability.read']))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.delete(row.id, actor, workspace, [])).rejects.toMatchObject({ status: 403 });
    expect(comments.update).not.toHaveBeenCalled(); expect(comments.softDelete).not.toHaveBeenCalled();
    const permission = kind === 'issue' ? 'workspace.write' : 'vulnerability.write';
    await expect(service.update(row.id, { content: 'Allowed' }, actor, workspace, [permission])).resolves.toMatchObject({ content: 'Allowed' });
    expect(events.publishSafely).toHaveBeenCalledTimes(kind === 'issue' ? 1 : 0);
    await expect(service.delete(row.id, actor, workspace, ['*'])).resolves.toEqual({ message: 'Comment deleted successfully' });
  });

  it('rejects another author and immutable system entries', async () => {
    await expect(service.delete(row.id, randomUUID(), workspace, ['*'])).rejects.toMatchObject({ status: 403 });
    row.type = IssueCommentType.OPEN;
    await expect(service.update(row.id, { content: 'System' }, actor, workspace, ['*'])).rejects.toMatchObject({ status: 403 });
    row.type = IssueCommentType.CONTENT; row.isCanEdit = false;
    await expect(service.update(row.id, { content: 'Immutable' }, actor, workspace, ['*'])).rejects.toMatchObject({ status: 403 });
    row.isCanDelete = false;
    await expect(service.delete(row.id, actor, workspace, ['*'])).rejects.toMatchObject({ status: 403 });
    expect(comments.update).not.toHaveBeenCalled(); expect(comments.softDelete).not.toHaveBeenCalled();
  });

  it('returns the same missing-comment message for missing, subjectless and foreign rows', async () => {
    query.getOne.mockResolvedValueOnce(null);
    await expect(service.delete(row.id, actor, workspace, ['*'])).rejects.toThrow('Comment not found');
    row.vulnerabilityId = null;
    await expect(service.delete(row.id, actor, workspace, ['*'])).rejects.toThrow('Comment not found');
    row.vulnerabilityId = subjectId; query.getExists.mockResolvedValue(false);
    await expect(service.delete(row.id, actor, workspace, ['*'])).rejects.toThrow('Comment not found');
    expect(comments.softDelete).not.toHaveBeenCalled();
  });

  it('returns 404 if the created row disappears before its response is read', async () => {
    query.getOne.mockResolvedValue(null);
    await expect(service.create(subject, { content: 'Concurrent subject removal' }, actor, workspace)).rejects.toMatchObject({ status: 404 });
  });
});
