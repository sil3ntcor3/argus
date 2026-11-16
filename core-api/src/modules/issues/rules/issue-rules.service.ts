import {
  IssueLinkResourceType,
  IssueRuleGroupBy,
  IssueType,
  Severity,
} from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, type EntityManager } from 'typeorm';
import type {
  CreateIssueRuleDto,
  IssueRuleDto,
  UpdateIssueRuleDto,
} from '../dto/issue-rule.dto';
import { IssueRule } from '../entities/issue-rule.entity';
import { assertWorkspaceMember, lockIssueWrites } from '../issue-activity';
import { IssueLinksService } from '../issue-links.service';

/** The rule `POST /issues/rules/defaults` installs. */
export const DEFAULT_ISSUE_RULE = {
  name: 'Critical & High',
  event: 'vulnerability.detected',
  conditions: { minSeverity: Severity.HIGH },
  issueType: IssueType.VULNERABILITY_REMEDIATION,
  groupBy: IssueRuleGroupBy.VULNERABILITY_NAME,
  priority: null,
} as const;

/** CRUD of a workspace's issue rules. */
@Injectable()
export class IssueRulesService {
  constructor(
    @InjectRepository(IssueRule)
    private readonly rulesRepository: Repository<IssueRule>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly links: IssueLinksService,
  ) {}

  async list(workspaceId: string): Promise<IssueRuleDto[]> {
    const rules = await this.rulesRepository.find({
      where: { workspaceId },
      order: { createdAt: 'ASC' },
    });
    return rules.map(toDto);
  }

  async create(
    dto: CreateIssueRuleDto,
    workspaceId: string,
    userId: string,
  ): Promise<IssueRuleDto> {
    const rule = await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId, userId);
      await this.validate(dto, workspaceId, manager);
      return manager.save(manager.create(IssueRule, {
        workspaceId, name: dto.name, enabled: dto.enabled ?? true, event: dto.event,
        conditions: dto.conditions ?? {}, issueType: dto.issueType,
        groupBy: dto.groupBy ?? IssueRuleGroupBy.VULNERABILITY_NAME,
        priority: dto.priority ?? null, defaultAssigneeId: dto.defaultAssigneeId ?? null, createdById: userId,
      }));
    });
    return toDto(rule);
  }

  async update(id: string, dto: UpdateIssueRuleDto, workspaceId: string): Promise<IssueRuleDto> {
    return this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId);
      const rule = await manager.findOne(IssueRule, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!rule) throw new NotFoundException('Issue rule not found in workspace');
      await this.validate(dto, workspaceId, manager);
      await manager.update(IssueRule, { id, workspaceId }, { ...dto, updatedAt: () => "statement_timestamp() AT TIME ZONE 'UTC'" });
      return toDto(Object.assign(rule, dto));
    });
  }

  async delete(id: string, workspaceId: string): Promise<{ message: string }> {
    await this.dataSource.transaction(async manager => {
      await lockIssueWrites(manager, workspaceId);
      const rule = await manager.findOne(IssueRule, { where: { id, workspaceId }, lock: { mode: 'pessimistic_write' } });
      if (!rule) throw new NotFoundException('Issue rule not found in workspace');
      await manager.delete(IssueRule, { id, workspaceId });
    });
    return { message: 'Issue rule deleted successfully' };
  }

  /**
   * Installs the default rule unless the workspace already has one by that
   * name. Serialised per workspace, so two clicks create one rule.
   */
  async createDefaults(
    workspaceId: string,
    userId: string,
  ): Promise<IssueRuleDto[]> {
    await this.dataSource.transaction(async (manager) => {
      await lockIssueWrites(manager, workspaceId, userId);
      const existing = await manager.findOne(IssueRule, {
        where: { workspaceId, name: DEFAULT_ISSUE_RULE.name },
      });
      if (existing) return;
      await manager.save(
        manager.create(IssueRule, {
          ...DEFAULT_ISSUE_RULE,
          conditions: { ...DEFAULT_ISSUE_RULE.conditions },
          workspaceId,
          enabled: true,
          defaultAssigneeId: null,
          createdById: userId,
        }),
      );
    });
    return this.list(workspaceId);
  }

  private async find(id: string, workspaceId: string): Promise<IssueRule> {
    const rule = await this.rulesRepository.findOne({
      where: { id, workspaceId },
    });
    if (!rule) throw new NotFoundException(`Issue rule with ID ${id} not found`);
    return rule;
  }

  /** The assignee is a member, and every target is in the workspace. */
  private async validate(
    dto: UpdateIssueRuleDto,
    workspaceId: string,
    reader: Pick<EntityManager, 'query'> = this.dataSource,
  ): Promise<void> {
    if (dto.defaultAssigneeId) {
      await assertWorkspaceMember(
        reader,
        workspaceId,
        dto.defaultAssigneeId,
      );
    }
    const targetIds = dto.conditions?.targetIds ?? [];
    if (targetIds.length > 0) {
      await this.links.assertInWorkspace(
        targetIds.map((resourceId) => ({
          resourceType: IssueLinkResourceType.TARGET,
          resourceId,
        })),
        workspaceId,
        reader,
      );
    }
  }
}

function toDto(rule: IssueRule): IssueRuleDto {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    event: rule.event,
    conditions: rule.conditions ?? {},
    issueType: rule.issueType,
    groupBy: rule.groupBy,
    priority: rule.priority ?? null,
    defaultAssigneeId: rule.defaultAssigneeId ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
