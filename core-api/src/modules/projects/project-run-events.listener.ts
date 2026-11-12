import { AuditActorType, AuditOutcome } from '@/common/enums/enum';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import type { ProjectRunCompletedPayload } from '../event-bridge/contracts/event-payloads';
import { EventBridgeService } from '../event-bridge/publishing/event-bridge.service';
import {
  PROJECT_RUN_CLOSED,
  runOutcomeOf,
} from './project-trigger-eligibility';

@Injectable()
export class ProjectRunEventsListener {
  private readonly logger = new Logger(ProjectRunEventsListener.name);
  constructor(
    private readonly db: DataSource,
    private readonly bridge: EventBridgeService,
  ) {}
  @OnEvent(PROJECT_RUN_CLOSED)
  async onRunClosed(runId: string): Promise<void> {
    if (!runId) return;
    try {
      const [run] = await this.db.query<
        {
          id: string;
          workspaceId: string;
          projectId: string;
          projectWorkflowId: string;
          workflowName: string;
          isCompleted: boolean;
          steps: unknown;
          activeJobs: number;
          cancelledJobs: number;
        }[]
      >(
        `SELECT h.id,p."workspaceId",p.id AS "projectId",pw.id AS "projectWorkflowId", w.name AS "workflowName",h."isCompleted",h.steps,
        (SELECT count(*)::int FROM jobs j WHERE j."jobHistoryId"=h.id AND j.status IN ('pending','in_progress')) AS "activeJobs",
        (SELECT count(*)::int FROM jobs j WHERE j."jobHistoryId"=h.id AND j.status='cancelled') AS "cancelledJobs"
        FROM job_histories h JOIN workflows w ON w.id=h."workflowId" JOIN projects p ON p.id=h."projectId"
        JOIN project_workflows pw ON pw.id=h."projectWorkflowId" AND pw."projectId"=p.id AND pw."workflowId"=w.id
        WHERE h.id=$1 AND p."workspaceId"=w."workspaceId" AND p."archivedAt" IS NULL`,
        [runId],
      );
      if (!run) return;
      const outcome = runOutcomeOf(run);
      if (!outcome) return;
      await this.bridge.publishSafely(EVENT_CATALOG.project.run.completed, {
        workspaceId: run.workspaceId,
        outcome: AuditOutcome.Success,
        actor: { type: AuditActorType.System },
        resourceType: 'project',
        resourceId: run.projectId,
        payload: {
          projectId: run.projectId,
          projectWorkflowId: run.projectWorkflowId,
          workflowName: run.workflowName,
          jobHistoryId: run.id,
          outcome,
        } satisfies ProjectRunCompletedPayload,
      });
    } catch {
      this.logger.warn('Could not publish project run completion');
    }
  }
}
