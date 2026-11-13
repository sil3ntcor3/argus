import { issueReadPermissions, canReadIssueResource, assertIssueResourceRead } from './issue-read-access';
import {
  type GetManyBaseResponseDto,
  SortOrder,
} from '@/common/dtos/get-many-base.dto';
import {
  IssueCommentType,
  IssuePriority,
  IssueLinkResourceType,
  IssueStatus,
  IssueType,
} from '@/common/enums/enum';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import { getManyResponse } from '@/utils/getManyResponse';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';
import {
  type GetManyIssuesDto,
  ISSUE_SORT_FIELDS,
  type IssueSortField,
} from './dto/get-many-issues.dto';
import type { AddIssueLinksDto, IssueLinkDto } from './dto/issue-link.dto';
import type {
  ChangeIssueStatusDto,
  CreateIssueDto,
  IssueDetailDto,
  IssueListItemDto,
  IssueProgressDto,
  IssueUserDto,
  UpdateIssueDto,
} from './dto/issue.dto';
import { IssueLink } from './entities/issue-link.entity';
import { Issue } from './entities/issue.entity';
import { IssueTypeHandlerRegistry } from './handlers/issue-type-handler.registry';
import {
  ACTIVE_ISSUE_STATUSES,
  assertWorkspaceMember,
  insertLinks,
  isActiveStatus,
  IssueEventsPublisher,
  isUniqueViolation,
  nextIssueNo,
  lockIssueWrites,
  uniqueLinks,
  writeSystemComment,
} from './issue-activity';
import { IssueLinksService } from './issue-links.service';

const toUser = (
  user: { id: string; name: string; image?: string | null } | null | undefined,
): IssueUserDto | null =>
  user ? { id: user.id, name: user.name, image: user.image ?? null } : null;

const isFinal = (status: IssueStatus): boolean =>
  status === IssueStatus.RESOLVED || status === IssueStatus.CLOSED;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

const sameDate = (a?: Date | null, b?: Date | null): boolean =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/**
 * Issues: generic work items. The core (status, priority, assignee, due date,
 * links, numbering) is the same for every type; progress and automation come
 * from the type's handler.
 *
 * Any workspace member with write permission may edit, assign and move an
 * issue — the controller's guard is the permission check, not authorship.
 */
@Injectable()
export class IssuesService {
  constructor(
    @InjectRepository(Issue)
    private readonly issuesRepository: Repository<Issue>,
    @InjectRepository(IssueLink)
    private readonly linksRepository: Repository<IssueLink>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly links: IssueLinksService,
    private readonly handlers: IssueTypeHandlerRegistry,
    private readonly events: IssueEventsPublisher,
  ) {}

  async createIssue(
    dto: CreateIssueDto,
    workspaceId: string,
    userId: string,
  ): Promise<IssueDetailDto> {
    const links = uniqueLinks(dto.links ?? []);
    const issue = await this.dataSource.transaction(async (manager) => {
      await lockIssueWrites(manager, workspaceId, userId);
      const access = await issueReadPermissions(manager, workspaceId, userId);
      assertIssueResourceRead(access, links.map(link => link.resourceType));
      if (dto.assigneeId) await assertWorkspaceMember(manager, workspaceId, dto.assigneeId);
      await this.links.assertInWorkspace(links, workspaceId, manager);
      const no = await nextIssueNo(manager, workspaceId);
      const saved = await manager.save(
        manager.create(Issue, {
          title: dto.title,
          description: dto.description,
          type: dto.type ?? IssueType.TASK,
          priority: dto.priority ?? IssuePriority.P3,
          status: IssueStatus.OPEN,
          dueAt: dto.dueAt ?? null,
          assigneeId: dto.assigneeId ?? null,
          tags: dto.tags,
          workspaceId,
          createdById: userId,
          no,
        }),
      );
      await manager.update(Issue, { id: saved.id, workspaceId }, { updatedAt: () => "statement_timestamp() AT TIME ZONE 'UTC'" });
      await insertLinks(manager, saved.id, links, userId);
      return saved;
    });

    await this.events.publish(
      EVENT_CATALOG.issue.created,
      issue,
      { userId },
      {
        linkCount: links.length,
        ...(issue.assigneeId ? { assigneeId: issue.assigneeId } : {}),
      },
    );
    return this.getById(issue.id, workspaceId, userId);
  }

  async getMany(
    query: GetManyIssuesDto,
    workspaceId: string,
    userId?: string,
  ): Promise<GetManyBaseResponseDto<IssueListItemDto>> {
    const access = await issueReadPermissions(this.dataSource, workspaceId, userId);
    if (query.resourceType) assertIssueResourceRead(access, [query.resourceType]);
    const { page, limit } = query;
    const qb = this.issuesRepository
      .createQueryBuilder('issue')
      .leftJoin('issue.assignee', 'assignee')
      .leftJoin('issue.createdBy', 'createdBy')
      .addSelect([
        'assignee.id',
        'assignee.name',
        'assignee.image',
        'createdBy.id',
        'createdBy.name',
        'createdBy.image',
      ])
      .loadRelationCountAndMap('issue.linkCount', 'issue.links')
      .where('issue.workspaceId = :workspaceId', { workspaceId });

    if (query.status?.length) {
      qb.andWhere('issue.status IN (:...status)', { status: query.status });
    }
    if (query.type?.length) {
      qb.andWhere('issue.type IN (:...type)', { type: query.type });
    }
    if (query.priority?.length) {
      qb.andWhere('issue.priority IN (:...priority)', {
        priority: query.priority,
      });
    }
    if (query.assigneeId) {
      qb.andWhere('issue.assigneeId = :assigneeId', {
        assigneeId: query.assigneeId,
      });
    }
    if (query.mine) {
      if (!userId) throw new BadRequestException('"mine" needs a user');
      qb.andWhere('issue.assigneeId = :me', { me: userId });
    }
    if (query.overdue) {
      qb.andWhere('issue.dueAt < now()').andWhere(
        'issue.status IN (:...active)',
        { active: ACTIVE_ISSUE_STATUSES },
      );
    }
    if (query.resourceType || query.resourceId) {
      if (!query.resourceType || !query.resourceId) {
        throw new BadRequestException(
          'resourceType and resourceId must be given together',
        );
      }
      qb.andWhere(
        `EXISTS (SELECT 1 FROM "issue_links" rl
                  WHERE rl."issueId" = issue.id
                    AND rl."resourceType" = :resourceType
                    AND rl."resourceId" = :resourceId)`,
        { resourceType: query.resourceType, resourceId: query.resourceId },
      );
    }
    const term = query.search?.trim();
    if (term) {
      const number = /^#?(\d{1,9})$/.exec(term);
      qb.andWhere(
        new Brackets((where) => {
          const title = canReadIssueResource(access, IssueLinkResourceType.VULNERABILITY) ? 'issue.title' : `CASE
            WHEN issue.type='vulnerability_remediation' AND (issue."ruleId" IS NOT NULL OR issue."groupKey" IS NOT NULL OR issue."sourceType" IS NOT NULL)
            THEN 'Remediation issue #' || issue.no::text ELSE issue.title END`;
          where.where(title + ' ILIKE :search', {
            search: `%${escapeLike(term)}%`,
          });
          if (number) where.orWhere('issue.no = :no', { no: Number(number[1]) });
        }),
      );
    }

    const sortBy: IssueSortField = (
      ISSUE_SORT_FIELDS as readonly string[]
    ).includes(query.sortBy)
      ? (query.sortBy as IssueSortField)
      : 'updatedAt';
    const order = query.sortOrder ?? SortOrder.DESC;
    qb.orderBy(`issue.${sortBy}`, order, 'NULLS LAST')
      .addOrderBy('issue.no', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [issues, total] = await qb.getManyAndCount();
    const progress = canReadIssueResource(access, IssueLinkResourceType.VULNERABILITY)
      ? await this.handlers.progress(issues) : new Map<string, IssueProgressDto | null>();
    return getManyResponse({
      query,
      data: issues.map((issue) =>
        this.toListItem(issue, progress.get(issue.id) ?? null, access),
      ),
      total,
    });
  }

  /** The issue with resolved links and progress. */
  async getById(id: string, workspaceId: string, userId?: string): Promise<IssueDetailDto> {
    const issue = await this.issuesRepository.findOne({
      where: { id, workspaceId },
      relations: { assignee: true, createdBy: true, links: true },
    });
    if (!issue) throw new NotFoundException(`Issue with ID ${id} not found`);

    const access = await issueReadPermissions(this.dataSource, workspaceId, userId);
    const links = [...(issue.links ?? [])].filter(link => canReadIssueResource(access, link.resourceType)).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const [summaries, progress] = await Promise.all([
      this.links.summarize(links, workspaceId),
      canReadIssueResource(access, IssueLinkResourceType.VULNERABILITY)
        ? this.handlers.get(issue.type).progress([issue.id]) : Promise.resolve(new Map<string, IssueProgressDto | null>()),
    ]);
    const linkDtos: IssueLinkDto[] = links.map((link, index) => ({
      id: link.id,
      resourceType: link.resourceType,
      resourceId: link.resourceId,
      addedById: link.addedById ?? null,
      createdAt: link.createdAt,
      resource: summaries[index],
    }));
    return {
      ...this.toListItem(
        Object.assign(issue, { linkCount: links.length }),
        progress.get(issue.id) ?? null,
        access,
      ),
      description: issue.description ?? null,
      groupKey: canReadIssueResource(access, IssueLinkResourceType.VULNERABILITY) ? issue.groupKey ?? null : null,
      links: linkDtos,
    };
  }

  async update(id: string, dto: UpdateIssueDto, userId: string, workspaceId: string): Promise<IssueDetailDto> {
    const { issue, changes, assigneeChanged } = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      const issue = await manager.findOne(Issue, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!issue) throw new NotFoundException('Issue not found in workspace');
      const changes: NonNullable<EventEnvelopeData['changes']> = {};
      const patch: Partial<Pick<Issue, 'title' | 'description' | 'priority' | 'tags' | 'dueAt' | 'assigneeId'>> = {};
      if (dto.title !== undefined && dto.title !== issue.title) patch.title = dto.title;
      if (dto.description !== undefined && (dto.description ?? '') !== (issue.description ?? '')) patch.description = dto.description ?? '';
      if (dto.priority !== undefined && dto.priority !== issue.priority) patch.priority = dto.priority;
      if (dto.tags !== undefined && JSON.stringify(dto.tags) !== JSON.stringify(issue.tags ?? [])) patch.tags = dto.tags;
      if (dto.dueAt !== undefined && !sameDate(dto.dueAt, issue.dueAt)) patch.dueAt = dto.dueAt;
      const assigneeChanged = dto.assigneeId !== undefined && (dto.assigneeId ?? null) !== (issue.assigneeId ?? null);
      if (assigneeChanged) {
        if (dto.assigneeId) await assertWorkspaceMember(manager, workspaceId, dto.assigneeId);
        patch.assigneeId = dto.assigneeId ?? null;
      }
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) changes[key] = { before: issue[key], after: patch[key] };
      if (Object.keys(patch).length) await manager.update(Issue, { id, workspaceId }, { ...patch, updatedAt: () => "statement_timestamp() AT TIME ZONE 'UTC'" });
      return { issue: Object.assign(issue, patch), changes, assigneeChanged };
    });
    if (Object.keys(changes).length) {
      await this.events.publish(EVENT_CATALOG.issue.updated, issue, { userId }, { fields: Object.keys(changes) }, changes);
      if (assigneeChanged) await this.events.publish(EVENT_CATALOG.issue.assigned, issue, { userId }, issue.assigneeId ? { assigneeId: issue.assigneeId } : {});
    }
    return this.getById(id, workspaceId, userId);
  }

  /**
   * Moves an issue. Resolving or closing needs a resolution; going back to
   * open / in progress clears it. Every change leaves a system comment.
   */
  async changeStatus(
    id: string,
    dto: ChangeIssueStatusDto,
    userId: string,
    workspaceId: string,
  ): Promise<IssueDetailDto> {
    const { issue, before, resolution, changed } = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      const issue = await manager.findOne(Issue, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!issue) throw new NotFoundException('Issue not found in workspace');
      const closing = isFinal(dto.status);
      if (closing && !dto.resolution) throw new BadRequestException('A resolution is required for a final issue status');
      const resolution = closing ? dto.resolution ?? null : null;
      const before = issue.status;
      if (before === dto.status && (issue.resolution ?? null) === resolution) return { issue, before, resolution, changed: false };
      const [{ now }] = await manager.query<{ now: Date }[]>('SELECT statement_timestamp() AS now');
      const patch = { status: dto.status, resolution, resolvedAt: closing ? (isFinal(before) && issue.resolvedAt ? issue.resolvedAt : now) : null };
      const commentType = closing ? IssueCommentType.CLOSED : dto.status === IssueStatus.OPEN ? IssueCommentType.OPEN : IssueCommentType.SYSTEM;
      const text = 'Status changed from ' + before + ' to ' + dto.status + (resolution ? ' (' + resolution + ')' : '') + (dto.note ? ': ' + dto.note : '');
      try {
        await manager.update(Issue, { id, workspaceId }, { ...patch, updatedAt: () => "statement_timestamp() AT TIME ZONE 'UTC'" });
        await writeSystemComment(manager, id, text, commentType, userId);
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Another active issue already tracks this group');
        throw error;
      }
      return { issue: Object.assign(issue, patch), before, resolution, changed: true };
    });
    if (!changed) return this.getById(id, workspaceId, userId);
    const event =
      dto.status === IssueStatus.RESOLVED
        ? EVENT_CATALOG.issue.resolved
        : dto.status === IssueStatus.CLOSED
          ? EVENT_CATALOG.issue.closed
          : isFinal(before) && isActiveStatus(dto.status)
            ? EVENT_CATALOG.issue.opened
            : EVENT_CATALOG.issue.updated;
    await this.events.publish(
      event,
      issue,
      { userId },
      resolution ? { resolution } : {},
      { status: { before, after: dto.status } },
    );
    return this.getById(id, workspaceId, userId);
  }

  async addLinks(
    id: string,
    dto: AddIssueLinksDto,
    userId: string,
    workspaceId: string,
  ): Promise<IssueDetailDto> {
    const links = uniqueLinks(dto.links);
    const { issue, added } = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      const issue = await manager.findOne(Issue, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!issue) throw new NotFoundException('Issue not found in workspace');
      const access = await issueReadPermissions(manager, workspaceId, userId);
      assertIssueResourceRead(access, links.map(link => link.resourceType));
      await this.links.assertInWorkspace(links, workspaceId, manager);
      return { issue, added: await insertLinks(manager, issue.id, links, userId) };
    });
    if (added > 0) {
      await this.events.publish(
        EVENT_CATALOG.issue.link.added,
        issue,
        { userId },
        {
          count: added,
          resourceTypes: [...new Set(links.map((l) => l.resourceType))],
        },
      );
    }
    return this.getById(id, workspaceId, userId);
  }

  async removeLink(
    id: string,
    linkId: string,
    userId: string,
    workspaceId: string,
  ): Promise<IssueDetailDto> {
    const { issue, link } = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      const issue = await manager.findOne(Issue, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!issue) throw new NotFoundException('Issue not found in workspace');
      const link = await manager.findOne(IssueLink, { where: { id: linkId, issueId: id } });
      if (!link) throw new NotFoundException('Link not found on issue');
      await manager.delete(IssueLink, { id: linkId, issueId: id });
      return { issue, link };
    });
    await this.events.publish(
      EVENT_CATALOG.issue.link.removed,
      issue,
      { userId },
      { resourceType: link.resourceType, resourceId: link.resourceId },
    );
    return this.getById(id, workspaceId, userId);
  }

  async delete(
    id: string,
    userId: string,
    workspaceId: string,
  ): Promise<{ message: string }> {
    const issue = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      const issue = await manager.findOne(Issue, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!issue) throw new NotFoundException('Issue not found in workspace');
      await manager.delete(Issue, { id, workspaceId });
      return issue;
    });
    await this.events.publish(EVENT_CATALOG.issue.deleted, issue, { userId });
    return { message: 'Issue deleted successfully' };
  }

  /** The issue entity, 404 unless it is in `workspaceId`. */
  async findInWorkspace(id: string, workspaceId: string): Promise<Issue> {
    const issue = await this.issuesRepository.findOne({
      where: { id, workspaceId },
    });
    if (!issue) throw new NotFoundException(`Issue with ID ${id} not found`);
    return issue;
  }

  private toListItem(
    issue: Issue & { linkCount?: number },
    progress: IssueProgressDto | null,
    access: string[] = ['*'],
  ): IssueListItemDto {
    return {
      id: issue.id,
      no: issue.no,
      title: issue.type === IssueType.VULNERABILITY_REMEDIATION && (issue.ruleId || issue.groupKey || issue.sourceType)
        && !canReadIssueResource(access, IssueLinkResourceType.VULNERABILITY) ? 'Remediation issue #' + issue.no : issue.title,
      type: issue.type,
      status: issue.status,
      priority: issue.priority,
      resolution: issue.resolution ?? null,
      dueAt: issue.dueAt ?? null,
      resolvedAt: issue.resolvedAt ?? null,
      tags: issue.tags ?? [],
      ruleId: issue.ruleId ?? null,
      assignee: toUser(issue.assignee),
      createdBy: toUser(issue.createdBy),
      linkCount: issue.linkCount ?? 0,
      progress,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }
}
