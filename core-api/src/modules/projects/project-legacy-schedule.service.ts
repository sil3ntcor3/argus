import { BullMQName } from '@/common/enums/enum';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { isValidCronSchedule } from '@/modules/asset-group/dto/cron-schedule.validator';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';

interface BindingSchedule {
  id: string;
  projectId: string;
  schedule: string;
  jobId: string | null;
  archivedAt: Date | null;
}

/** Repair desired legacy schedules after committed writes, without sweeping other keys. */
@Injectable()
export class ProjectLegacyScheduleService {
  constructor(
    private readonly db: DataSource,
    @InjectQueue(BullMQName.ASSET_GROUPS_WORKFLOW_SCHEDULE)
    private readonly queue: Queue,
  ) {}
  async remove(rows: { id: string; jobId: string | null }[]): Promise<void> {
    for (const row of rows)
      if (row.jobId) {
        const scheduler = await this.queue.getJobScheduler(row.jobId);
        if (scheduler?.name === row.id)
          await this.queue.removeJobScheduler(row.jobId);
      }
  }
  async reconcile(projectId?: string, workspaceId?: string): Promise<void> {
    await this.db.transaction((manager) =>
      this.reconcileWithManager(manager, projectId, workspaceId),
    );
  }

  /** One coordination lock covers legacy restoration and trigger deduplication. */
  async reconcileWithManager(
    manager: EntityManager,
    projectId?: string,
    workspaceId?: string,
  ): Promise<void> {
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtext('argus-project-trigger-schedulers'))",
    );
    // Freeze candidates before acquiring ordered cascade-parent locks. New
    // bindings are deferred instead of escaping the parents protected here.
    const candidates = await manager.query<
      {
        id: string;
        projectId: string;
        workflowId: string;
        workspaceId: string;
      }[]
    >(
      `SELECT pw.id,pw."projectId",pw."workflowId",p."workspaceId" FROM project_workflows pw
       JOIN projects p ON p.id=pw."projectId" JOIN workflows w ON w.id=pw."workflowId"
       WHERE w."workspaceId"=p."workspaceId"${projectId ? ' AND p.id=$1 AND p."workspaceId"=$2' : ''}`,
      projectId ? [projectId, workspaceId] : [],
    );
    if (!candidates.length) return;
    const workspaceIds = [...new Set(candidates.map((row) => row.workspaceId))];
    const projectIds = [...new Set(candidates.map((row) => row.projectId))];
    const workflowIds = [...new Set(candidates.map((row) => row.workflowId))];
    await manager.query(
      'SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
      [workspaceIds],
    );
    await manager.query(
      'SELECT id FROM projects WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [projectIds],
    );
    await manager.query(
      'SELECT id FROM workflows WHERE id=ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
      [workflowIds],
    );
    const rows = await manager.query<BindingSchedule[]>(
      `SELECT pw.id,pw."projectId",pw.schedule,pw."jobId",p."archivedAt" FROM project_workflows pw
       JOIN projects p ON p.id=pw."projectId" JOIN workflows w ON w.id=pw."workflowId"
       WHERE pw.id=ANY($1::uuid[]) AND pw."projectId"=ANY($2::uuid[]) AND pw."workflowId"=ANY($3::uuid[])
       AND p."workspaceId"=ANY($4::uuid[]) AND w."workspaceId"=p."workspaceId" ORDER BY pw.id FOR UPDATE OF pw`,
      [candidates.map((row) => row.id), projectIds, workflowIds, workspaceIds],
    );
    for (const row of rows) {
      if (
        row.archivedAt ||
        row.schedule === 'disabled' ||
        !isValidCronSchedule(row.schedule)
      ) {
        await this.remove([row]);
        await manager
          .createQueryBuilder()
          .update(AssetGroupWorkflow)
          .set({ jobId: null })
          .where('id=:id AND "jobId" IS NOT DISTINCT FROM :oldKey', {
            id: row.id,
            oldKey: row.jobId,
          })
          .andWhere(
            'EXISTS(SELECT 1 FROM projects p WHERE p.id="projectId" AND (p."archivedAt" IS NOT NULL OR schedule=\'disabled\'))',
          )
          .execute();
        continue;
      }
      const current = row.jobId
        ? await this.queue.getJobScheduler(row.jobId)
        : null;
      if (current?.name === row.id && current.pattern === row.schedule)
        continue;
      // New identity means a delayed delivery from before archive cannot match.
      const key = `project-legacy:${row.id}:${randomUUID()}`;
      await this.queue.upsertJobScheduler(
        key,
        { pattern: row.schedule, tz: 'UTC' },
        {
          name: row.id,
          data: { id: row.id },
          opts: { removeOnComplete: true, removeOnFail: 1000 },
        },
      );
      const result = await manager
        .createQueryBuilder()
        .update(AssetGroupWorkflow)
        .set({ jobId: key })
        .where(
          'id=:id AND schedule=:schedule AND "jobId" IS NOT DISTINCT FROM :oldKey',
          { id: row.id, schedule: row.schedule, oldKey: row.jobId },
        )
        .andWhere(
          'EXISTS(SELECT 1 FROM projects p WHERE p.id="projectId" AND p."archivedAt" IS NULL)',
        )
        .execute();
      if (!result.affected) await this.queue.removeJobScheduler(key);
      else await this.remove([row]);
    }
  }
}
