import type { WrapperType } from '@/common/types/app.types';
import { Inject, forwardRef } from '@nestjs/common';
import type { ReviewReader } from './vulnerability-review-read';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { SortOrder } from '@/common/dtos/get-many-base.dto';
import {
  BullMQName,
  JobRunType,
  Severity,
  TargetType,
  ToolCategory,
  VulnerabilityAnalyzeStatus,
} from '@/common/enums/enum';
import { getManyResponse } from '@/utils/getManyResponse';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { isISO8601 } from 'class-validator';
import { Brackets, In, Repository } from 'typeorm';
import { AgentsCompletionsService } from '../agents/agents.completions';
import { User } from '../auth/entities/user.entity';
import { JobsRegistryService } from '../jobs-registry/jobs-registry.service';
import { WorkflowRunnerService } from '../jobs-registry/workflow-runner.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Target } from '../targets/entities/target.entity';
import { ToolsService } from '../tools/tools.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { normalizeInput, orderedJobEntries } from '../workflows/workflow-graph';
import {
  GetVulnerabilitiesStatisticsQueryDto,
  VulnerabilityStatisticsDto,
} from './dto/get-vulnerability-statistics.dto';
import {
  GetVulnerabilitiesQueryDto,
  VulnerabilityStatus,
} from './dto/get-vulnerability.dto';
import {
  TIMELINE_EVENT_TYPES,
  type VulnerabilityTimelineEventDto,
  type VulnerabilityTimelineResponseDto,
} from './dto/vulnerability-timeline.dto';
import { dismissFindings, type FindingDismissalInput } from './dismiss-findings';
import { Vulnerability } from './entities/vulnerability.entity';
import {
  FINDING_DISMISS_REASONS,
  RISK_ACCEPTED,
} from './finding-dismissal-reason';
import {
  activeDismissalCondition,
  openVulnerabilityCondition,
} from './open-vulnerability';
import { reopenFindings } from './reopen-findings';
import { compileVulnerabilityFilter } from './vulnerability-filter';
import { findingLifecycleStatistics, LIFECYCLE_READ_COLUMNS, projectFindingLifecycle } from './vulnerability-lifecycle-read';

@Injectable()
export class VulnerabilitiesService {
  private readonly logger = new Logger(VulnerabilitiesService.name);

  constructor(
    @InjectRepository(Vulnerability)
    private vulnerabilitiesRepository: Repository<Vulnerability>,
    @InjectQueue(BullMQName.VULNERABILITY_ANALYSIS)
    private vulnerabilityAnalysisQueue: Queue,
    private jobRegistryService: JobsRegistryService,
    private toolsService: ToolsService,
    private workflowService: WorkflowsService,
    @Inject(forwardRef(() => AgentsCompletionsService))
    private agentsCompletionsService: WrapperType<AgentsCompletionsService>,
    private notificationsService: NotificationsService,
    @InjectRepository(Target)
    private targetRepository: Repository<Target>,
    private workflowRunnerService: WorkflowRunnerService,
  ) {}

  /**
   * Initiates a vulnerability scan for the given targets. Host targets
   * (DOMAIN, CIDR, IP) run the nuclei step of `vulnerability_scan_basic`;
   * Git organization targets run the whole `repository_scan` workflow.
   *
   * @param targetIds - The IDs of the targets to scan.
   * @returns A message indicating the scan has started.
   */
  public async scan(targetIds: string[], workspaceId: string) {
    const targets = await this.targetRepository.find({
      where: { id: In(targetIds), workspaceId },
      select: { id: true, type: true, value: true },
    });
    if (targets.length === 0) {
      throw new NotFoundException('No targets found in the workspace.');
    }

    const gitOrgTargets = targets.filter((t) => t.type === TargetType.GIT_ORG);
    const hostTargetIds = targets
      .filter((t) => t.type !== TargetType.GIT_ORG)
      .map((t) => t.id);

    // Resolve every workflow first so a missing one fails before anything is
    // dispatched.
    const hostWorkflow = hostTargetIds.length
      ? await this.findScanWorkflow('vulnerability_scan_basic.yaml', workspaceId)
      : null;
    const repositoryWorkflow = gitOrgTargets.length
      ? await this.findScanWorkflow('repository_scan.yaml', workspaceId)
      : null;

    if (hostWorkflow) {
      const tools = await this.toolsService.getToolByNames({
        names: ['nuclei'],
      });
      // Dependency order, not stored order: `content.jobs` is a map and jsonb
      // does not preserve its key order, so "the first job" is only meaningful
      // when it is derived from the graph.
      const job = orderedJobEntries(hostWorkflow.content.jobs)[0]?.[1];
      await this.jobRegistryService.createNewJob({
        tool: tools[0],
        workflow: hostWorkflow,
        targetIds: hostTargetIds,
        priority: tools[0].priority,
        workspaceId,
        config: job?.config,
        configProfileId: job?.configProfileId,
        category: job?.category as ToolCategory | undefined,
        input: normalizeInput(job?.input),
      });
    }

    if (repositoryWorkflow) {
      // Every step (secrets, dependencies…) runs, not just the first one.
      await this.workflowRunnerService.startRun({
        workflow: repositoryWorkflow,
        workspaceId,
        jobName:
          gitOrgTargets.length === 1
            ? `${repositoryWorkflow.name} - ${gitOrgTargets[0].value}`
            : `${repositoryWorkflow.name} - ${gitOrgTargets.length} targets`,
        jobRunType: JobRunType.MANUAL,
        targetIds: gitOrgTargets.map((t) => t.id),
      });
    }

    return { message: `Scanning ${targets.length} target(s)...` };
  }

  private async findScanWorkflow(filePath: string, workspaceId: string) {
    const workflow = await this.workflowService.workflowRepository.findOne({
      where: { workspace: { id: workspaceId }, filePath },
    });
    if (!workflow) {
      throw new NotFoundException(
        `Scanning workflow ${filePath} not found in the workspace.`,
      );
    }
    return workflow;
  }

  /**
   * Retrieves a paginated list of vulnerabilities associated with a specified workspace.
   *
   * @param query - The query parameters to filter and paginate the vulnerabilities,
   *                including page, limit, sortOrder, targetIds, workspaceId, and optional search query 'q'.
   * @returns A promise that resolves to a paginated list of vulnerabilities, including total count and pagination information.
   */
  async getVulnerabilities(
    query: GetVulnerabilitiesQueryDto,
    workspaceId: string,
    canReadJobs = false,
    reader: ReviewReader = {},
    view: 'rest' | 'model' = 'rest',
  ) {
    const {
      limit,
      page,
      sortOrder,
      targetIds,
      q,
      status,
      severity,
      createdFrom,
      createdTo,
      tags,
      targetId,
      filter,
    } = query;

    const { sortBy } = query;

    const queryBuilder = this.vulnerabilitiesRepository
      .createQueryBuilder('vulnerabilities')
      .addSelect(LIFECYCLE_READ_COLUMNS.map(column => `vulnerabilities.${column}`))
      .leftJoin('vulnerabilities.asset', 'assets')
      .addSelect(['assets.id', 'assets.value'])
      .leftJoin('assets.target', 'targets')
      .leftJoin('targets.workspace', 'workspaces')
      .leftJoinAndSelect('vulnerabilities.tool', 'tools')
      .leftJoin('vulnerabilities.jobHistory', 'jobHistory')
      .leftJoinAndSelect(
        'vulnerabilities.vulnerabilityDismissal',
        'dismissal',
        activeDismissalCondition('dismissal'),
      )
      .where('workspaces.id = :workspaceId', { workspaceId })
      .skip((page - 1) * limit)
      .take(limit);

    // Expiry is private on the relation; select it only for the approved tool projection.
    if (view === 'model') queryBuilder.addSelect('dismissal.expiresAt');

    // Handle severity sorting with proper order
    if (sortBy === 'severity') {
      const { select, orderBy } = this.buildSeverityOrderQuery(sortOrder);
      queryBuilder.addSelect(select, 'severity_order').orderBy(orderBy, 'ASC');
    } else {
      queryBuilder.orderBy(`vulnerabilities.${sortBy}`, sortOrder);
    }
    queryBuilder.addOrderBy('vulnerabilities.id', 'ASC');

    if (targetIds) {
      queryBuilder.andWhere('targets.id IN (:...targetIds)', { targetIds });
    }

    if (targetId) {
      queryBuilder.andWhere('targets.id = :targetId', { targetId });
    }

    // Add search query if provided
    if (q) {
      queryBuilder.andWhere('"vulnerabilities"."name" ILIKE :q   ', {
        q: `%${q}%`,
        qArray: `%${q}%`,
      });
    }

    const reviewStatus = [VulnerabilityStatus.PENDING_REVIEW, VulnerabilityStatus.REJECTED].includes(status as VulnerabilityStatus) ? status : 'approved';
    queryBuilder.andWhere('vulnerabilities.reviewStatus = :reviewStatus', { reviewStatus });
    if (query.discoveredBy?.length) queryBuilder.andWhere('vulnerabilities.discoveredBy IN (:...discoveredBy)', { discoveredBy: query.discoveredBy });

    // Filter by status
    if (status === VulnerabilityStatus.OPEN) {
      queryBuilder.andWhere(openVulnerabilityCondition('vulnerabilities'));
    } else if (status === VulnerabilityStatus.DISMISSED) {
      queryBuilder.andWhere('dismissal.vulnerabilityId IS NOT NULL');
    } else if (status === VulnerabilityStatus.FIXED) {
      queryBuilder.andWhere('vulnerabilities.detectionStatus = :detectionStatus', { detectionStatus: 'fixed' });
    } else if ([VulnerabilityStatus.NEW, VulnerabilityStatus.ACTIVE, VulnerabilityStatus.RESURFACED].includes(status as VulnerabilityStatus)) {
      queryBuilder.andWhere(openVulnerabilityCondition('vulnerabilities'))
        .andWhere('vulnerabilities.detectionStatus = :detectionStatus', { detectionStatus: status });
    }
    if (query.overdue) queryBuilder.andWhere(openVulnerabilityCondition('vulnerabilities'))
      .andWhere('vulnerabilities.dueAt < statement_timestamp()');

    // Filter by severity levels
    if (Array.isArray(severity) && severity.length > 0) {
      queryBuilder.andWhere('vulnerabilities.severity IN (:...severity)', {
        severity,
      });
    }

    // Tools use first detection; preserve existing REST creation-date semantics.
    const dateFilter = (operator: '>=' | '<=', parameter: 'createdFrom' | 'createdTo', value: Date) => {
      if (view === 'rest') return queryBuilder.andWhere(`vulnerabilities.createdAt ${operator} :${parameter}`, { [parameter]: value });
      // Separate timestamp/timestamptz bindings preserve legacy clocks on non-UTC hosts.
      return queryBuilder.andWhere(new Brackets(date => date
        .where(`vulnerabilities.firstDetectedDate ${operator} :detected_${parameter}`, { [`detected_${parameter}`]: value })
        .orWhere(`vulnerabilities.firstDetectedDate IS NULL AND vulnerabilities.createdAt ${operator} :${parameter}`, { [parameter]: value })));
    };
    if (createdFrom) {
      dateFilter('>=', 'createdFrom', new Date(createdFrom));
    }
    if (createdTo) {
      // Set time to end of day (23:59:59.999) to include the entire day
      const endDate = new Date(createdTo);
      if (view === 'model') endDate.setUTCHours(23, 59, 59, 999);
      else endDate.setHours(23, 59, 59, 999);
      dateFilter('<=', 'createdTo', endDate);
    }

    // Filter by tags (using overlap operator with raw SQL)
    if (Array.isArray(tags) && tags.length > 0) {
      const conditions = tags
        .map((_, i) => `:tag${i} = ANY(vulnerabilities.tags)`)
        .join(' OR ');
      const params: Record<string, string> = {};
      tags.forEach((tag, i) => {
        params[`tag${i}`] = tag;
      });
      queryBuilder.andWhere(`(${conditions})`, params);
    }

    const compiled = filter && compileVulnerabilityFilter(filter, 'vf');
    if (compiled) queryBuilder.andWhere(compiled.sql, compiled.params);

    const [vulnerabilities, total] = await queryBuilder.getManyAndCount();

    const data = await projectFindingLifecycle(this.vulnerabilitiesRepository.manager, vulnerabilities, workspaceId, canReadJobs, false, reader);
    return getManyResponse({ query, data, total });
  }

  /**
   * Retrieves a vulnerability by id
   *
   * @param id - The ID of the vulnerability to retrieve.
   * @param workspaceId - The ID of the workspace to which the vulnerability belongs.
   * @returns A promise that resolves to the vulnerability entity.
   */
  async getVulnerability(id: string, workspaceId: string, canReadJobs = false, reader: ReviewReader = {}) {
    const queryBuilder = this.vulnerabilitiesRepository
      .createQueryBuilder('vulnerabilities')
      .addSelect(LIFECYCLE_READ_COLUMNS.map(column => `vulnerabilities.${column}`))
      .leftJoin('vulnerabilities.fixClaimedBy', 'fixActor')
      .addSelect(['fixActor.id', 'fixActor.name', 'fixActor.image'])
      .leftJoin('vulnerabilities.asset', 'assets')
      .addSelect(['assets.id', 'assets.value'])
      .leftJoin('assets.target', 'targets')
      .leftJoin('targets.workspace', 'workspaces')
      .leftJoinAndSelect('vulnerabilities.tool', 'tools')
      .leftJoin('vulnerabilities.jobHistory', 'jobHistory')
      .leftJoinAndSelect(
        'vulnerabilities.vulnerabilityDismissal',
        'dismissal',
        activeDismissalCondition('dismissal'),
      )
      .addSelect('dismissal.expiresAt')
      .leftJoinAndSelect('dismissal.user', 'user')
      .where('workspaces.id = :workspaceId', { workspaceId })
      .andWhere('vulnerabilities.id = :id', { id });

    const vulnerability = await queryBuilder.getOne();

    if (!vulnerability) {
      throw new NotFoundException(
        `Vulnerability with id ${id} not found in workspace`,
      );
    }

    const dismissal = vulnerability.vulnerabilityDismissal;
    if (dismissal && (dismissal.reason !== RISK_ACCEPTED || !dismissal.expiresAt)) {
      delete dismissal.expiresAt;
    }
    return (await projectFindingLifecycle(this.vulnerabilitiesRepository.manager, [vulnerability], workspaceId, canReadJobs, true, reader))[0];
  }

  /**
   * Retrieves statistics of vulnerabilities by severity level for a specified workspace.
   *
   * @param query - The query parameters to filter vulnerabilities, with optional targetIds.
   * @param workspaceId - The ID of the workspace.
   * @returns A promise that resolves to an array of vulnerability counts by severity level.
   */
  async getVulnerabilitiesStatistics(
    query: GetVulnerabilitiesStatisticsQueryDto,
    workspaceId: string,
  ) {
    const { targetIds } = query;

    const queryBuilder = this.vulnerabilitiesRepository
      .createQueryBuilder('vulnerabilities')
      .select('vulnerabilities.severity', 'severity')
      .addSelect('COUNT(vulnerabilities.severity)', 'count')
      .leftJoin('vulnerabilities.asset', 'assets')
      .leftJoin('assets.target', 'targets')
      .leftJoin('targets.workspace', 'workspaces')
      .leftJoin('vulnerabilities.jobHistory', 'jobHistory')
      .where('workspaces.id = :workspaceId', { workspaceId })
      .andWhere(openVulnerabilityCondition('vulnerabilities'))
      .groupBy('vulnerabilities.severity');

    if (targetIds) {
      queryBuilder.andWhere('targets.id IN (:...targetIds)', { targetIds });
    }

    const result = await queryBuilder.getRawMany();

    // Convert the result to a map for easy lookup
    const severityCounts = new Map<Severity, number>();
    result.forEach((item: { severity: Severity; count: string }) => {
      severityCounts.set(item.severity, parseInt(item.count, 10));
    });

    // Ensure all severity levels are included, even with zero counts
    const allSeverities: Severity[] = [
      Severity.INFO,
      Severity.LOW,
      Severity.MEDIUM,
      Severity.HIGH,
      Severity.CRITICAL,
    ];

    const statistics: VulnerabilityStatisticsDto[] = allSeverities.map(
      (severity) => ({
        severity,
        count: severityCounts.get(severity) || 0,
      }),
    );

    const [{ pendingReview }] = await this.vulnerabilitiesRepository.manager.query<{ pendingReview: number }[]>(`SELECT COUNT(*)::int AS "pendingReview" FROM vulnerabilities v JOIN assets a ON a.id=v."assetId" JOIN targets t ON t.id=a."targetId" WHERE t."workspaceId"=$1 AND v."reviewStatus"='pending_review' AND ($2::uuid[] IS NULL OR t.id=ANY($2::uuid[]))`, [workspaceId, targetIds?.length ? targetIds : null]);
    return { data: statistics, pendingReview,
      ...await findingLifecycleStatistics(this.vulnerabilitiesRepository.manager, workspaceId, targetIds) };
  }

  /**
   * Updates the isArchived status of a vulnerability.
   *
   * @param id - The ID of the vulnerability to update.
   * @param isArchived - The new boolean value for isArchived.
   * @returns A promise that resolves when the update is complete.
   */
  async markIsArchived(id: string, isArchived: boolean): Promise<void> {
    await this.vulnerabilitiesRepository.update({ id }, { isArchived });
  }

  async getVulnerabilityTimeline(
    id: string,
    workspaceId: string,
    canReadJobs: boolean,
  ): Promise<VulnerabilityTimelineResponseDto> {
    type TimelineRow =
      | (Omit<VulnerabilityTimelineEventDto, 'dismissalReason' | 'expiresAt'> & {
          rawReason: string | null;
          rawExpiry: string | null;
          rawVerification: string | null;
          rawVerified: unknown;
        })
      | { id: null };
    // An owned finding with no events still has one row; a missing or foreign
    // finding has none. Both the finding and the event must be in scope.
    const rows = await this.vulnerabilitiesRepository.manager.query<
      TimelineRow[]
    >(
      `SELECT event.id, event.type, event."occurredAt",
              CASE WHEN event."fromStatus" IN ('new','active','fixed','resurfaced','pending_review','approved','rejected') THEN event."fromStatus" END AS "fromStatus",
              CASE WHEN event."toStatus" IN ('new','active','fixed','resurfaced','pending_review','approved','rejected') THEN event."toStatus" END AS "toStatus",
              CASE WHEN workflow."workspaceId" = target."workspaceId" THEN history.id END AS "jobHistoryId",
              CASE event.type
                WHEN 'dismissed' THEN event.data ->> 'reason'
                WHEN 'reopened' THEN event.data ->> 'previousReason'
                WHEN 'risk_expired' THEN 'risk_accepted'
              END AS "rawReason",
              CASE WHEN event.type IN ('dismissed', 'reopened', 'risk_expired')
                THEN event.data ->> 'expiresAt'
              END AS "rawExpiry",
              CASE WHEN event.type='fix_claimed' THEN event.data->>'verification' END AS "rawVerification",
              CASE WHEN event.type='status_changed' AND event."toStatus"='fixed'
                AND event.data->>'reason'='not_detected_by_covering_scan'
                AND event.data->'coverageVersion'='1'::jsonb
                AND jsonb_typeof(event.data->'fixClaimVerified')='boolean'
                THEN event.data->'fixClaimVerified' END AS "rawVerified"
       FROM vulnerabilities AS finding
       JOIN assets AS asset ON asset.id = finding."assetId"
       JOIN targets AS target ON target.id = asset."targetId"
       LEFT JOIN LATERAL (
         SELECT id, type, "occurredAt", "fromStatus", "toStatus", "jobHistoryId", data
         FROM vulnerability_events
         WHERE "vulnerabilityId" = finding.id AND "workspaceId" = target."workspaceId"
           AND type = ANY($4::varchar[])
         ORDER BY "occurredAt" DESC, id DESC
         LIMIT 500
       ) AS event ON true
       LEFT JOIN job_histories AS history
         ON $3::boolean AND event.type IN ('detected', 'status_changed') AND history.id = event."jobHistoryId"
       LEFT JOIN workflows AS workflow ON workflow.id = history."workflowId"
       WHERE finding.id = $1 AND target."workspaceId" = $2
       ORDER BY event."occurredAt" DESC, event.id DESC`,
      [id, workspaceId, canReadJobs, TIMELINE_EVENT_TYPES],
    );
    if (rows.length === 0)
      throw new NotFoundException('Vulnerability not found');
    const data: VulnerabilityTimelineEventDto[] = [];
    for (const row of rows) {
      if (row.id === null) continue;
      const { rawReason, rawExpiry, rawVerification, rawVerified, ...event } = row;
      const dismissalReason = FINDING_DISMISS_REASONS.find(
        (reason) => reason === rawReason,
      );
      const expiresAt =
        dismissalReason === RISK_ACCEPTED &&
        rawExpiry &&
        /(?:Z|[+-]\d{2}:\d{2})$/.test(rawExpiry) &&
        isISO8601(rawExpiry, { strict: true, strictSeparator: true })
          ? new Date(rawExpiry)
          : undefined;
      data.push({
        ...event,
        ...(rawVerification === 'next_covering_scan' || rawVerification === 'not_verifiable_by_scan'
          ? { verification: rawVerification } : {}),
        ...(typeof rawVerified === 'boolean' ? { fixClaimVerified: rawVerified } : {}),
        ...(dismissalReason ? { dismissalReason } : {}),
        ...(expiresAt && Number.isFinite(expiresAt.getTime()) ? { expiresAt } : {}),
      });
    }
    return { data };
  }

  /**
   * Builds the SQL CASE expression for severity ordering.
   *
   * @param sortOrder - The sort order ('ASC' or 'DESC').
   * @returns An object containing the select expression and order by field.
   */
  private buildSeverityOrderQuery(sortOrder: SortOrder | undefined): {
    select: string;
    orderBy: string;
  } {
    const severityCase =
      sortOrder === SortOrder.ASC
        ? `CASE vulnerabilities.severity WHEN '${Severity.INFO}' THEN 1 WHEN '${Severity.LOW}' THEN 2 WHEN '${Severity.MEDIUM}' THEN 3 WHEN '${Severity.HIGH}' THEN 4 WHEN '${Severity.CRITICAL}' THEN 5 END`
        : `CASE vulnerabilities.severity WHEN '${Severity.INFO}' THEN 5 WHEN '${Severity.LOW}' THEN 4 WHEN '${Severity.MEDIUM}' THEN 3 WHEN '${Severity.HIGH}' THEN 2 WHEN '${Severity.CRITICAL}' THEN 1 END`;

    return {
      select: severityCase,
      orderBy: 'severity_order',
    };
  }

  async bulkDismissVulnerabilities(
    ids: string[],
    workspaceId: string,
    user: User,
    dismiss: FindingDismissalInput,
  ) {
    return this.vulnerabilitiesRepository.manager.transaction((manager) =>
      dismissFindings(manager, ids, workspaceId, user.id, dismiss),
    );
  }

  async bulkReopenVulnerabilities(ids: string[], workspaceId: string, user: User) {
    return this.vulnerabilitiesRepository.manager.transaction((manager) =>
      reopenFindings(manager, ids, workspaceId, user.id),
    );
  }

  async analyzeVulnerability(
    id: string,
    workspaceId: string,
    userId: string,
    forceRerun: boolean = false,
  ): Promise<DefaultMessageResponseDto> {
    // Lightweight query: only verify workspace, no JOINs to tool/dismissal/user/jobHistory
    const vulnerability = await this.vulnerabilitiesRepository
      .createQueryBuilder('v')
      .leftJoin('v.asset', 'asset')
      .leftJoin('asset.target', 'target')
      .leftJoin('target.workspace', 'workspace')
      .where('v.id = :id', { id })
      .andWhere('workspace.id = :workspaceId', { workspaceId })
      .getOne();

    if (!vulnerability) {
      throw new NotFoundException(`Vulnerability with id ${id} not found`);
    }

    if (!forceRerun) {
      if (vulnerability.analyzeStatus === VulnerabilityAnalyzeStatus.RUNNING) {
        throw new BadRequestException(
          'Analysis is already running for this vulnerability',
        );
      }
      if (
        vulnerability.analyzeStatus === VulnerabilityAnalyzeStatus.DONE &&
        vulnerability.analyzeResult
      ) {
        this.logger.log(
          `Vulnerability ${id} already analyzed, returning cached result`,
        );
        return {
          message: vulnerability.analyzeResult,
        };
      }
    }

    await this.vulnerabilitiesRepository.update(
      { id },
      { analyzeStatus: VulnerabilityAnalyzeStatus.RUNNING },
    );
    this.logger.log(`Starting analysis for vulnerability ${id}`);

    await this.vulnerabilityAnalysisQueue.add(id, {
      ...this.toAnalysisPayload(vulnerability),
      workspaceId,
      userId,
    });

    return {
      message: 'Analysis started',
    };
  }

  async processVulnerabilityAnalysis(
    jobId: string,
    workspaceId: string,
    userId: string,
  ): Promise<Vulnerability | undefined> {
    const vulnerability = await this.vulnerabilitiesRepository.findOne({
      where: { id: jobId },
    });

    if (!vulnerability) {
      this.logger.error(`Vulnerability with id ${jobId} not found`);
      return;
    }

    try {
      const vulnerabilityJson = JSON.stringify(
        this.toAnalysisPayload(vulnerability),
        null,
        2,
      );
      const analyzeResult = await this.agentsCompletionsService.vulAnalyze(
        vulnerabilityJson,
        workspaceId,
        userId,
      );

      const hasMarkdownStructure =
        analyzeResult.includes('###') ||
        analyzeResult.includes('##') ||
        analyzeResult.includes('#');

      if (!hasMarkdownStructure) {
        this.logger.warn(
          `AI returned non-markdown content for vulnerability ${jobId}, wrapping as error`,
        );
        const errorContent = `# Analysis Error\n\nAI returned invalid content:\n\n${analyzeResult}`;
        await this.vulnerabilitiesRepository.update(
          { id: jobId },
          {
            analyzeStatus: VulnerabilityAnalyzeStatus.FAILED,
            analyzeResult: errorContent,
          },
        );
        return;
      }

      await this.vulnerabilitiesRepository.update(
        { id: jobId },
        {
          analyzeStatus: VulnerabilityAnalyzeStatus.DONE,
          analyzeResult,
        },
      );

      this.logger.log(`Analysis completed for vulnerability ${jobId}`);

      return vulnerability;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error(
        `Analysis failed for vulnerability ${jobId}: ${errorMessage}`,
      );

      await this.vulnerabilitiesRepository.update(
        { id: jobId },
        {
          analyzeStatus: VulnerabilityAnalyzeStatus.FAILED,
          analyzeResult: `# Analysis Error\n\n**Error details:** ${errorMessage}`,
        },
      );
    }
  }

  private toAnalysisPayload(
    vulnerability: Vulnerability,
  ): Record<string, unknown> {
    return {
      id: vulnerability.id,
      name: vulnerability.name,
      description: vulnerability.description,
      synopsis: vulnerability.synopsis,
      severity: vulnerability.severity,
      tags: vulnerability.tags,
      references: vulnerability.references,
      authors: vulnerability.authors,
      affectedUrl: vulnerability.affectedUrl,
      ipAddress: vulnerability.ipAddress,
      host: vulnerability.host,
      ports: vulnerability.ports,
      cvssMetric: vulnerability.cvssMetric,
      cvssScore: vulnerability.cvssScore,
      epssScore: vulnerability.epssScore,
      vprScore: vulnerability.vprScore,
      cveId: vulnerability.cveId,
      bidId: vulnerability.bidId,
      cweId: vulnerability.cweId,
      ceaId: vulnerability.ceaId,
      iava: vulnerability.iava,
      cveUrl: vulnerability.cveUrl,
      cweUrl: vulnerability.cweUrl,
      solution: vulnerability.solution,
      extractorName: vulnerability.extractorName,
      extractedResults: vulnerability.extractedResults,
      publicationDate: vulnerability.publicationDate,
      modificationDate: vulnerability.modificationDate,
      filePath: vulnerability.filePath,
      isArchived: vulnerability.isArchived,
      fingerprint: vulnerability.fingerprint,
    };
  }

  async deleteVulnerabilityAnalysis(
    id: string,
    workspaceId: string,
  ): Promise<DefaultMessageResponseDto> {
    const vulnerability = await this.vulnerabilitiesRepository.findOne({
      where: { id },
      relations: ['asset', 'asset.target'],
    });

    if (!vulnerability) {
      throw new NotFoundException(`Vulnerability with id ${id} not found`);
    }

    const workspace = vulnerability.asset?.target?.workspace;
    if (!workspace || workspace.id !== workspaceId) {
      throw new NotFoundException(
        `Vulnerability with id ${id} not found in workspace`,
      );
    }

    await this.vulnerabilitiesRepository.update(
      { id },
      {
        analyzeStatus: VulnerabilityAnalyzeStatus.NOT_ANALYZED,
        analyzeResult: '',
      },
    );

    return { message: 'Analysis result deleted successfully' };
  }
}
