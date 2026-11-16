import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ARCHIVE_PENDING } from './project-archive-state';
import { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import { ProjectLegacyScheduleService } from './project-legacy-schedule.service';
import { ProjectMetadataReadService } from './project-metadata-read.service';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';

@Injectable()
export class ProjectArchiveService {
  private readonly logger = new Logger(ProjectArchiveService.name);
  constructor(
    private readonly db: DataSource,
    private readonly legacy: ProjectLegacyScheduleService,
    private readonly runtime: ProjectTriggerRuntimeService,
    private readonly metadata: ProjectMetadataReadService,
  ) {}
  async setArchived(id: string, workspaceId: string, archived: boolean) {
    const transition = await this.db.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM workspaces WHERE id=$1 FOR KEY SHARE',
        [workspaceId],
      );
      const [project] = await manager.query<
        { id: string; archivedAt: Date | null }[]
      >(
        'SELECT id,"archivedAt" FROM projects WHERE id=$1 AND "workspaceId"=$2 FOR NO KEY UPDATE',
        [id, workspaceId],
      );
      if (!project) throw new NotFoundException('Project not found');
      if (Boolean(project.archivedAt) === archived)
        return {
          projectId: project.id,
          oldKeys: [] as { id: string; jobId: string | null }[],
        };
      // Generic workflow saves hold this lock while checking archived ownership.
      await manager.query(
        'SELECT w.id FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw."projectId"=$1 AND w."workspaceId"=$2 ORDER BY w.id FOR UPDATE OF w',
        [project.id, workspaceId],
      );
      const oldKeys = await manager.query<
        { id: string; jobId: string | null }[]
      >(
        'SELECT id,"jobId" FROM project_workflows WHERE "projectId"=$1 ORDER BY id FOR UPDATE',
        [project.id],
      );
      const [clock] = await manager.query<{ cutoff: string }[]>(
        'SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS cutoff',
      );
      // A fresh token also fences a reconciler whose old snapshot had no key.
      for (const binding of oldKeys)
        await manager.update(
          AssetGroupWorkflow,
          { id: binding.id },
          { jobId: `${ARCHIVE_PENDING}${clock.cutoff}.${randomUUID()}` },
        );
      const triggers = await manager.query<{ id: string }[]>(
        'SELECT tr.id FROM project_workflow_triggers tr JOIN project_workflows pw ON pw.id=tr."projectWorkflowId" WHERE pw."projectId"=$1 ORDER BY tr.id FOR UPDATE OF tr',
        [project.id],
      );
      await manager.update(
        AssetGroup,
        { id: project.id },
        { archivedAt: archived ? new Date() : null },
      );
      for (const trigger of triggers)
        await manager.update(
          ProjectWorkflowTrigger,
          { id: trigger.id },
          { schedulerId: `${ARCHIVE_PENDING}${clock.cutoff}.${randomUUID()}` },
        );
      return { projectId: project.id, oldKeys };
    });
    // A Redis failure cannot undo or misreport a committed archive. Durable
    // private markers make periodic reconciliation retry window cleanup first.
    try {
      await this.legacy.remove(transition.oldKeys);
    } catch {
      this.logger.warn('Legacy key cleanup deferred to stale-delivery cleanup');
    }
    try {
      await this.legacy.reconcile(transition.projectId, workspaceId);
    } catch {
      this.logger.warn('Legacy schedule restoration will retry');
    }
    // Trigger deduplication depends on the restored legacy scheduler reference.
    try {
      await this.runtime.reconcile();
    } catch {
      this.logger.warn('Project trigger reconciliation will retry');
    }
    return this.metadata.getById(transition.projectId, workspaceId);
  }
}
