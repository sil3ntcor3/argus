import {
  BullMQName,
  AuditActorType,
  AuditOutcome,
  JobRunType,
  Severity,
  type TargetType,
} from '@/common/enums/enum';
import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import { isUUID } from 'class-validator';
import {
  WorkflowRunnerService,
  type StartRunInput,
} from '../jobs-registry/workflow-runner.service';
import { Workflow } from '../workflows/entities/workflow.entity';
import type { ConsumedEvent } from '../event-bridge/contracts/event-envelope';
import { isGroupOwnedWorkflow } from '../asset-group/workflow-ownership';
import { isValidCronSchedule } from '../asset-group/dto/cron-schedule.validator';
import {
  ProjectTriggerBatchService,
  type ProjectTriggerEventJob,
  type TriggerBatchCause,
} from './project-trigger-batch.service';
import { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import { normalizeEventConfig, isTriggerEvent } from './project-trigger-config';
import {
  matchTriggers,
  chunk,
  type ProjectTriggerMatchFact,
} from './project-trigger-matching';
import { triggerChainDepth, runOutcomeOf } from './project-trigger-eligibility';
import { lockEditableProjectWorkflow } from './project-workflow-write-context';
import { ProjectLegacyScheduleService } from './project-legacy-schedule.service';
import {
  ARCHIVE_PENDING, EVENT_EPOCH, INACTIVE_TRIGGER, ProjectArchivedException,
  triggerEpoch, triggerCutoff,
} from './project-archive-state';

interface RuntimeTrigger extends ProjectWorkflowTrigger {
  projectId: string;
  workspaceId: string;
  workflowId: string;
  archivedAt: Date | null;
  filePath: string;
  isCanEdit: boolean;
  isCanDelete: boolean;
  legacySchedule: string;
  legacyJobId: string | null;
}
const TRIGGERS = `SELECT tr.*, pw."projectId", pw."workflowId", p."workspaceId", p."archivedAt",
  w."filePath", w."isCanEdit", w."isCanDelete", pw.schedule AS "legacySchedule", pw."jobId" AS "legacyJobId"
  FROM project_workflow_triggers tr JOIN project_workflows pw ON pw.id=tr."projectWorkflowId"
  JOIN projects p ON p.id=pw."projectId" JOIN workflows w ON w.id=pw."workflowId"
  WHERE w."workspaceId"=p."workspaceId"`;
class TriggerUnavailable extends Error {}

/** Stable durable handoff identity: retries of one batch create one run per chunk. */
function runIdFor(key: string): string {
  const bytes = createHash('sha256')
    .update(`argus-project-trigger-v1:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function definitionOf(row: ProjectWorkflowTrigger): string {
  return JSON.stringify([
    row.type,
    row.cron,
    row.event,
    isTriggerEvent(row.event)
      ? normalizeEventConfig(row.event, row.config)
      : {},
  ]);
}

@Injectable()
export class ProjectTriggerRuntimeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectTriggerRuntimeService.name);
  constructor(
    private readonly db: DataSource,
    private readonly runner: WorkflowRunnerService,
    @InjectQueue(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE)
    private readonly schedules: Queue,
    private readonly batches: ProjectTriggerBatchService,
    private readonly legacy: ProjectLegacyScheduleService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcile();
    } catch {
      this.logger.warn(
        'Project trigger scheduling will retry during reconciliation',
      );
    }
  }
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile(): Promise<void> {
    await this.db.transaction(async (manager) => {
      // Serialize replicas without a lease expiring while Redis is slow.
      await manager.query(
        "SELECT pg_advisory_xact_lock(hashtext('argus-project-trigger-schedulers'))",
      );
      await this.legacy.reconcileWithManager(manager);
      const rows = await manager.query<RuntimeTrigger[]>(TRIGGERS);
      const existing = await this.schedules.getJobSchedulers();
      const existingKeys = new Set(existing.map((scheduler) => scheduler.key));
      const wanted = new Set<string>();
      for (const row of rows) {
        const previous = row.schedulerId;
        const epoch = triggerEpoch(previous);
        const pending = Boolean(previous?.startsWith(ARCHIVE_PENDING));
        if (pending) {
          // Keep the durable pending marker if Redis fails; do not reactivate
          // a trigger until its pre-archive windows have been discarded.
          await this.batches.clear(row.id, epoch);
          row.schedulerId = (row.type === 'event' ? EVENT_EPOCH : INACTIVE_TRIGGER) + epoch;
        }
        const key = `project-trigger:${row.id}${epoch ? ':' + epoch : ''}`;
        const active =
          this.active(row) &&
          row.type === 'cron' &&
          row.cron &&
          isValidCronSchedule(row.cron) &&
          // An identical legacy binding schedule already supplies this firing.
          !(
            row.legacyJobId &&
            row.legacySchedule === row.cron &&
            existingKeys.has(row.legacyJobId)
          );
        if (active) {
          wanted.add(key);
          await this.schedules.upsertJobScheduler(
            key,
            { pattern: row.cron!, tz: 'UTC' },
            {
              name: 'project-trigger',
              data: { triggerId: row.id, cron: row.cron, ...(epoch ? { epoch } : {}) },
              opts: {
                attempts: 5,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: true,
                removeOnFail: 1000,
              },
            },
          );
        }
        const desired = active ? key : epoch ? (row.type === 'event' ? EVENT_EPOCH : INACTIVE_TRIGGER) + epoch : null;
        if (previous !== desired)
          await manager.createQueryBuilder().update(ProjectWorkflowTrigger).set({ schedulerId: desired })
            .where('id=:id AND "schedulerId" IS NOT DISTINCT FROM :previous', { id: row.id, previous })
            .andWhere('enabled=:enabled AND type=:type AND cron IS NOT DISTINCT FROM :cron AND event IS NOT DISTINCT FROM :event AND config=CAST(:config AS jsonb)', { enabled: row.enabled, type: row.type, cron: row.cron, event: row.event, config: JSON.stringify(row.config) })
            .execute();
        if (!this.active(row) && !pending) await this.batches.clear(row.id, epoch);
      }
      for (const scheduler of existing)
        if (
          scheduler.key.startsWith('project-trigger:') &&
          !wanted.has(scheduler.key)
        )
          await this.schedules.removeJobScheduler(scheduler.key);
    });
  }
  async clear(id: string): Promise<void> {
    const row = await this.load(id);
    await this.batches.clear(id, triggerEpoch(row?.schedulerId));
  }
  private active(row: RuntimeTrigger): boolean {
    return (
      row.enabled &&
      !row.schedulerId?.startsWith(ARCHIVE_PENDING) &&
      !row.archivedAt &&
      row.isCanEdit &&
      isGroupOwnedWorkflow(row, row.projectId)
    );
  }
  private async load(id: string): Promise<RuntimeTrigger | undefined> {
    return (
      await this.db.query<RuntimeTrigger[]>(TRIGGERS + ' AND tr.id=$1', [id])
    )[0];
  }
  private async assets(
    manager: Pick<EntityManager, 'query'>,
    row: RuntimeTrigger,
    ids?: string[],
    types: TargetType[] = [],
    lock = false,
  ): Promise<string[]> {
    const rows = await manager.query<{ id: string }[]>(
      `SELECT a.id FROM project_assets pa JOIN assets a ON a.id=pa."assetId"
       JOIN targets t ON t.id=a."targetId" JOIN projects p ON p.id=pa."projectId"
       WHERE p.id=$1 AND p."workspaceId"=$2 AND p."archivedAt" IS NULL
       AND t."workspaceId"=$2 AND a."isEnabled"=true
       AND ($3::uuid[] IS NULL OR a.id=ANY($3::uuid[]))
       AND (cardinality($4::text[])=0 OR t.type=ANY($4::text[]))
       ORDER BY a.id ${lock ? 'FOR SHARE OF a' : ''}`,
      [row.projectId, row.workspaceId, ids ?? null, types],
    );
    return rows.map((asset) => asset.id);
  }
  async fireCron(
    triggerId: string,
    deliveryId: string,
    expectedCron?: string,
    expectedEpoch?: string,
  ): Promise<void> {
    const row = await this.load(triggerId);
    if (
      !row ||
      !this.active(row) ||
      row.type !== 'cron' ||
      triggerEpoch(row.schedulerId) !== expectedEpoch ||
      (expectedCron !== undefined && row.cron !== expectedCron)
    )
      return;
    await this.launch(
      row,
      undefined,
      null,
      runIdFor(`cron:${triggerId}:${deliveryId}`),
    );
  }
  async fireEvent({ triggerId, token, epoch }: ProjectTriggerEventJob): Promise<void> {
    const row = await this.load(triggerId);
    if (
      !row ||
      !this.active(row) ||
      row.type !== 'event' ||
      !isTriggerEvent(row.event)
    ) {
      await this.batches.clear(triggerId, epoch);
      return;
    }
    if (triggerEpoch(row.schedulerId) !== epoch) return;
    const config = normalizeEventConfig(row.event, row.config);
    const batch = await this.batches.take(
      triggerId,
      token,
      config.maxAssets ?? 200,
      epoch,
    );
    if (batch.assetIds.length === 0) return;
    // Chunk the original stable snapshot, then intersect current membership per
    // chunk. Membership changes cannot shift retry identities onto other assets.
    const groups = chunk(
      [...batch.assetIds].sort(),
      batch.maxAssets ?? config.maxAssets ?? 200,
    );
    for (const [index, ids] of groups.entries())
      await this.launch(
        row,
        ids,
        batch.cause,
        runIdFor(`event:${triggerId}:${token}:${index}`),
      );
    await this.batches.acknowledge(triggerId, token, epoch);
  }
  private async launch(
    row: RuntimeTrigger,
    ids: string[] | undefined,
    cause: TriggerBatchCause | null,
    runId: string,
  ): Promise<void> {
    const workflow = await this.db.manager.findOne(Workflow, {
      where: { id: row.workflowId, workspace: { id: row.workspaceId } },
      relations: { workspace: true },
    });
    if (!workflow) return;
    const input: StartRunInput = {
      workflow,
      workspaceId: row.workspaceId,
      jobName: workflow.name,
      jobRunType: row.type === 'cron' ? JobRunType.SCHEDULED : JobRunType.EVENT,
      projectId: row.projectId,
      projectWorkflowId: row.projectWorkflowId,
      triggerId: row.id,
      causedByRunId: cause?.runId,
      chainDepth: cause?.depth ?? 0,
      runId,
    };
    try {
      const result = await this.runner.startRun(input, async (manager) => {
        const locked = await lockEditableProjectWorkflow(
          manager,
          row.projectId,
          row.workspaceId,
          row.projectWorkflowId,
        );
        const current = await manager.findOne(ProjectWorkflowTrigger, {
          where: { id: row.id, projectWorkflowId: row.projectWorkflowId },
          lock: { mode: 'pessimistic_read' },
        });
        if (
          !current?.enabled ||
          triggerEpoch(current.schedulerId) !== triggerEpoch(row.schedulerId) ||
          definitionOf(current) !== definitionOf(row) ||
          locked.workflow.updatedAt.getTime() !== workflow.updatedAt.getTime()
        )
          throw new TriggerUnavailable('Trigger changed before dispatch');
        if (cause) {
          const [parent] = await manager.query<
            { chainDepth: number; steps: unknown; cancelled: boolean }[]
          >(
            `SELECT h."chainDepth",h.steps, EXISTS(SELECT 1 FROM jobs j WHERE j."jobHistoryId"=h.id AND j.status='cancelled') AS cancelled FROM job_histories h JOIN workflows w ON w.id=h."workflowId" WHERE h.id=$1 AND w."workspaceId"=$2 FOR SHARE OF h`,
            [cause.runId, row.workspaceId],
          );
          if (
            !parent ||
            parent.cancelled ||
            (parent.steps &&
              typeof parent.steps === 'object' &&
              Object.values(parent.steps).some(
                (state: unknown) =>
                  state &&
                  typeof state === 'object' &&
                  (state as { reason?: unknown }).reason === 'run-cancelled',
              )) ||
            cause.depth !== parent.chainDepth + 1 ||
            cause.depth > 3
          )
            throw new TriggerUnavailable('Causal run is no longer available');
        }
        input.assetIds = await this.assets(
          manager,
          row,
          ids,
          isTriggerEvent(row.event)
            ? normalizeEventConfig(row.event, row.config).targetTypes
            : [],
          true,
        );
        if (!input.assetIds.length)
          throw new TriggerUnavailable('No eligible project assets');
      });
      if (result.jobHistory)
        await this.db.manager.update(
          ProjectWorkflowTrigger,
          { id: row.id },
          { lastFiredAt: new Date() },
        );
    } catch (error) {
      if (error instanceof TriggerUnavailable || error instanceof ProjectArchivedException) return;
      throw error;
    }
  }

  /** Validate all transport facts against stored workspace/run membership. */
  async handleEvent(name: string, event: ConsumedEvent): Promise<void> {
    if (!isTriggerEvent(name) || !isUUID(event.workspaceId)) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return;
    const uuid = (value: unknown): value is string =>
      typeof value === 'string' && isUUID(value);
    let fact: ProjectTriggerMatchFact,
      projectId: string | undefined,
      assets: string[];
    let causeId: string | undefined;
    let deliveryId = event.eventId;
    if (name === 'project.assets.added') {
      if (!uuid(payload.projectId) || !Array.isArray(payload.assetIds)) return;
      projectId = payload.projectId;
      assets = [...new Set(payload.assetIds.filter(uuid))];
      if (payload.jobHistoryId !== undefined) {
        if (!uuid(payload.jobHistoryId)) return;
        causeId = payload.jobHistoryId;
      }
      fact = { event: name };
    } else if (name === 'project.run.completed') {
      if (
        !uuid(payload.projectId) ||
        !uuid(payload.projectWorkflowId) ||
        !uuid(payload.jobHistoryId)
      )
        return;
      projectId = payload.projectId;
      causeId = payload.jobHistoryId;
      assets = [];
      fact = {
        event: name,
        projectWorkflowId: payload.projectWorkflowId,
        workflowName: '',
        outcome: 'success',
      };
    } else if (payload.jobId === undefined) {
      // An approval is not a scanner job. Rehydrate the exact durable human
      // decision, never infer coverage or trust the transport's severity.
      const approvalEventId = event.metadata?.approvalEventId;
      if (event.outcome !== AuditOutcome.Success || event.actor?.type !== AuditActorType.User ||
        event.resourceType !== 'vulnerability' || !uuid(event.resourceId) || !uuid(event.actor.id) ||
        !uuid(approvalEventId) || !uuid(payload.assetId) || !Array.isArray(payload.vulnerabilities) ||
        payload.vulnerabilities.length !== 1 ||
        (payload.vulnerabilities[0] as { id?: unknown } | null)?.id !== event.resourceId) return;
      const [approved] = await this.db.query<{ assetId: string; severity: Severity }[]>(
        `SELECT finding."assetId",finding.severity FROM vulnerability_events review
         JOIN vulnerabilities finding ON finding.id=review."vulnerabilityId"
         JOIN assets asset ON asset.id=finding."assetId" JOIN targets target ON target.id=asset."targetId"
         WHERE review.id=$1 AND review.type='approved' AND review."workspaceId"=$2 AND target."workspaceId"=$2
           AND finding.id=$3 AND finding."reviewStatus"='approved' AND finding."reviewedById"=$4
           AND review."actorId"=$4 AND finding."reviewedAt" IS NOT NULL
           AND finding."firstDetectedDate"=finding."reviewedAt" AND review."occurredAt">=finding."reviewedAt"
           AND finding."assetId"=$5`,
        [approvalEventId,event.workspaceId,event.resourceId,event.actor.id,payload.assetId]);
      if (!approved || !Object.values(Severity).includes(approved.severity)) return;
      assets = [approved.assetId]; fact = { event:'vulnerability.detected',severities:[approved.severity] };
      // Different transport deliveries of one human decision still gather once.
      deliveryId = approvalEventId;
    } else {
      if (
        !uuid(payload.jobId) ||
        !uuid(payload.assetId) ||
        !Array.isArray(payload.vulnerabilities)
      )
        return;
      const [job] = await this.db.query<{ jobHistoryId: string }[]>(
        `SELECT j."jobHistoryId" FROM jobs j JOIN assets a ON a.id=j."assetId" JOIN targets t ON t.id=a."targetId" JOIN job_histories h ON h.id=j."jobHistoryId" JOIN workflows w ON w.id=h."workflowId"
         WHERE j.id=$1 AND a.id=$2 AND t."workspaceId"=$3 AND w."workspaceId"=$3`,
        [payload.jobId, payload.assetId, event.workspaceId],
      );
      if (!job) return;
      causeId = job.jobHistoryId;
      assets = [payload.assetId];
      const severities = payload.vulnerabilities.flatMap((v: unknown) => {
        const severity =
          v && typeof v === 'object'
            ? (v as { severity?: unknown }).severity
            : undefined;
        return Object.values(Severity).some((s) => s === severity)
          ? [severity as Severity]
          : [];
      });
      fact = { event: name, severities };
    }
    let cause:
      | {
          id: string;
          chainDepth: number;
          projectWorkflowId: string | null;
          projectId: string | null;
          scope: { assetIds?: string[] } | null;
          isCompleted: boolean;
          steps: unknown;
          workflowName: string;
          cancelled: boolean;
        }
      | undefined;
    if (causeId) {
      [cause] = await this.db.query<(typeof cause)[]>(
        `SELECT h.id, h."chainDepth",h."projectWorkflowId",h."projectId",h.scope,h."isCompleted",h.steps,w.name AS "workflowName", EXISTS(SELECT 1 FROM jobs j WHERE j."jobHistoryId"=h.id AND j.status='cancelled') AS cancelled
         FROM job_histories h JOIN workflows w ON w.id=h."workflowId" WHERE h.id=$1 AND w."workspaceId"=$2`,
        [causeId, event.workspaceId],
      );
      if (
        !cause ||
        cause.cancelled ||
        (cause.steps &&
          typeof cause.steps === 'object' &&
          Object.values(cause.steps).some(
            (state: unknown) =>
              state &&
              typeof state === 'object' &&
              (state as { reason?: unknown }).reason === 'run-cancelled',
          ))
      )
        return;
    }
    if (name === 'project.run.completed' && cause && fact.event === name) {
      if (
        cause.projectId !== projectId ||
        cause.projectWorkflowId !== fact.projectWorkflowId
      )
        return;
      const [counts] = await this.db.query<
        { activeJobs: number; cancelledJobs: number }[]
      >(
        `SELECT count(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS "activeJobs",count(*) FILTER (WHERE status='cancelled')::int AS "cancelledJobs" FROM jobs WHERE "jobHistoryId"=$1`,
        [cause.id],
      );
      const outcome = runOutcomeOf({ ...cause, ...counts });
      if (!outcome) return;
      fact = { ...fact, outcome, workflowName: cause.workflowName };
      assets = cause.scope?.assetIds ?? [];
    }
    const rows = await this.db.query<RuntimeTrigger[]>(
      TRIGGERS +
        ' AND p."workspaceId"=$1 AND tr.event=$2 AND tr.enabled=true AND p."archivedAt" IS NULL' +
        (projectId ? ' AND p.id=$3' : ''),
      projectId
        ? [event.workspaceId, name, projectId]
        : [event.workspaceId, name],
    );
    for (const { trigger } of matchTriggers(
      fact,
      rows.filter((row) => {
        if (!this.active(row)) return false;
        const cutoff = triggerCutoff(row.schedulerId);
        if (cutoff === undefined) return true;
        const occurred = event.occurredAt && /(?:Z|[+-]\d{2}:\d{2})$/i.test(event.occurredAt) ? Date.parse(event.occurredAt) : NaN;
        return Number.isFinite(occurred) && occurred >= cutoff;
      }),
      assets,
    )) {
      const depth = triggerChainDepth(
        name,
        trigger.projectWorkflowId,
        cause ?? null,
      );
      if (depth === null) continue;
      const config = normalizeEventConfig(name, trigger.config);
      const eligible = await this.assets(
        this.db.manager,
        trigger,
        assets,
        config.targetTypes,
      );
      await this.batches.gather(
        trigger.id,
        eligible,
        cause ? { runId: cause.id, depth } : null,
        config.windowMinutes ?? 10,
        deliveryId,
        triggerEpoch(trigger.schedulerId),
      );
    }
  }
}
