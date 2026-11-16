import type { GetManyBaseQueryParams } from '@/common/dtos/get-many-base.dto';
import { AuditActorType, AuditOutcome, IssueCommentType } from '@/common/enums/enum';
import { IssueComment } from '@/modules/issues/entities/issue-comment.entity';
import { Issue } from '@/modules/issues/entities/issue.entity';
import { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { EVENT_CATALOG, type CatalogEvent } from '@/modules/event-bridge/contracts/event-catalog';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { getManyResponse } from '@/utils/getManyResponse';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { CommentResponseDto, CreateCommentDto, UpdateCommentDto } from './dto/comment.dto';

type Subject = { kind: 'issue' | 'vulnerability'; id: string };
const authorDto = (user?: { id: string; name: string; image?: string | null } | null) =>
  user ? { id: user.id, name: user.name, image: user.image ?? null } : null;

/** Dedicated resource discussions; legacy issue routes and automation stay disabled. */
@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(IssueComment) private readonly comments: Repository<IssueComment>,
    @InjectRepository(Issue) private readonly issues: Repository<Issue>,
    @InjectRepository(Vulnerability) private readonly findings: Repository<Vulnerability>,
    private readonly events: EventBridgeService,
  ) {}

  /** Resolve every subject in the selected workspace before accessing its discussion. */
  private async assertSubject(subject: Subject, workspaceId: string, message = 'Discussion subject not found') {
    const exists = subject.kind === 'issue'
      ? await this.issues.existsBy({ id: subject.id, workspaceId })
      : await this.findings.createQueryBuilder('finding')
        .innerJoin('finding.asset', 'asset').innerJoin('asset.target', 'target')
        .where('finding.id = :id AND target.workspaceId = :workspaceId', { id: subject.id, workspaceId }).getExists();
    if (!exists) throw new NotFoundException(message);
  }

  /** Project the private finding subject only inside this authorized DTO path. */
  private query() {
    return this.comments.createQueryBuilder('comment').withDeleted()
      .leftJoin('comment.createdBy', 'author')
      .leftJoin('comment.repComment', 'parent',
        '(comment.issueId IS NOT NULL AND parent.issueId = comment.issueId) OR ' +
        '(comment.vulnerabilityId IS NOT NULL AND parent.vulnerabilityId = comment.vulnerabilityId)')
      .leftJoin('parent.createdBy', 'parentAuthor')
      .select(['comment', 'author.id', 'author.name', 'author.image',
        'parent.id', 'parent.content', 'parent.deletedAt', 'parentAuthor.id', 'parentAuthor.name', 'parentAuthor.image'])
      .addSelect('comment.vulnerabilityId').where('comment.deletedAt IS NULL');
  }

  /** Stable oldest-first pagination keeps equal creation timestamps from moving between pages. */
  async list(subject: Subject, query: GetManyBaseQueryParams, workspaceId: string) {
    await this.assertSubject(subject, workspaceId);
    const [rows, total] = await this.query()
      .andWhere(subject.kind === 'issue' ? 'comment.issueId = :id' : 'comment.vulnerabilityId = :id', { id: subject.id })
      .orderBy('comment.createdAt', 'ASC').addOrderBy('comment.id', 'ASC')
      .skip((query.page - 1) * query.limit).take(query.limit).getManyAndCount();
    return getManyResponse({ query, total, data: rows.map(row => this.dto(row)) });
  }

  /** Replies may reference a live comment only within the same resolved thread. */
  async create(subject: Subject, dto: CreateCommentDto, userId: string, workspaceId: string) {
    await this.assertSubject(subject, workspaceId);
    if (dto.repCommentId) {
      const parent = await this.comments.findOne({ where: { id: dto.repCommentId,
        ...(subject.kind === 'issue' ? { issueId: subject.id } : { vulnerabilityId: subject.id }) }, select: ['id'] });
      if (!parent) throw new BadRequestException('The replied-to comment does not belong to this thread');
    }
    const saved = await this.comments.save(this.comments.create({
      content: dto.content, repCommentId: dto.repCommentId, createdById: userId,
      ...(subject.kind === 'issue' ? { issueId: subject.id } : { vulnerabilityId: subject.id }),
      type: IssueCommentType.CONTENT, isCanEdit: true, isCanDelete: true,
    }));
    await this.publish(subject.kind === 'issue' ? EVENT_CATALOG.issue.comment.created : EVENT_CATALOG.vulnerability.comment.created,
      subject, saved.id, userId, workspaceId);
    return this.get(saved.id);
  }

  /** Permission revocation prevents even an author from subsequently changing a discussion. */
  private async own(id: string, userId: string, workspaceId: string, permissions: string[], action: 'edit' | 'delete') {
    const row = await this.query().andWhere('comment.id = :id', { id }).getOne();
    if (!row) throw new NotFoundException('Comment not found');
    const subject: Subject | null = row.issueId ? { kind: 'issue', id: row.issueId }
      : row.vulnerabilityId ? { kind: 'vulnerability', id: row.vulnerabilityId } : null;
    if (!subject) throw new NotFoundException('Comment not found');
    await this.assertSubject(subject, workspaceId, 'Comment not found');
    const key = subject.kind === 'issue' ? 'workspace.write' : 'vulnerability.write';
    if (!permissions.includes('*') && !permissions.includes(key)) throw new ForbiddenException('Discussion write permission required');
    if (row.createdById !== userId || row.type !== IssueCommentType.CONTENT ||
      !(action === 'edit' ? row.isCanEdit : row.isCanDelete)) throw new ForbiddenException('Comment cannot be changed');
    return { row, subject };
  }

  /** Update only content; an edit cannot move a comment or change its reply or author. */
  async update(id: string, dto: UpdateCommentDto, userId: string, workspaceId: string, permissions: string[]) {
    const { row, subject } = await this.own(id, userId, workspaceId, permissions, 'edit');
    await this.comments.update(row.id, { content: dto.content });
    if (subject.kind === 'issue') await this.publish(EVENT_CATALOG.issue.comment.updated, subject, id, userId, workspaceId);
    return this.get(id);
  }

  /** Keep replies while replacing their parent excerpt with the deleted marker. */
  async delete(id: string, userId: string, workspaceId: string, permissions: string[]) {
    await this.own(id, userId, workspaceId, permissions, 'delete');
    await this.comments.softDelete(id);
    return { message: 'Comment deleted successfully' };
  }

  private async get(id: string) {
    const row = await this.query().andWhere('comment.id = :id', { id }).getOne();
    if (!row) throw new NotFoundException('Comment not found');
    return this.dto(row);
  }

  /** Exclude storage fields, private user attributes and deleted reply bodies. */
  private dto(row: IssueComment): CommentResponseDto {
    const parent = row.repComment;
    return { id: row.id, content: row.content, type: row.type, issueId: row.issueId ?? null,
      vulnerabilityId: row.vulnerabilityId ?? null, isCanEdit: row.isCanEdit, isCanDelete: row.isCanDelete,
      createdAt: row.createdAt, updatedAt: row.updatedAt, author: authorDto(row.createdBy),
      repComment: parent ? { id: parent.id, snippet: parent.deletedAt ? '' : parent.content.slice(0, 200),
        deleted: Boolean(parent.deletedAt), author: authorDto(parent.createdBy) } : null };
  }

  /** Events identify the discussion and actor without carrying comment or reply content. */
  private async publish(event: CatalogEvent, subject: Subject, commentId: string, userId: string, workspaceId: string) {
    await this.events.publishSafely(event, {
      workspaceId, actor: { id: userId, type: AuditActorType.User }, outcome: AuditOutcome.Success,
      resourceType: subject.kind, resourceId: subject.id, metadata: { commentId },
    }, { subject: `workspace:${workspaceId}/${subject.kind}:${subject.id}` });
  }
}
