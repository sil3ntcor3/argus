import { Severity, TargetType } from '@/common/enums/enum';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  PROJECT_TRIGGER_EVENTS,
  type ProjectTriggerConfigDto,
  type ProjectTriggerDto,
} from './dto/project-trigger-read.dto';
import type { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';

const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined;
const choices = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is T => allowed.some((v) => v === item))
    : undefined;

/** Only known non-secret settings belong in the public read model. */
function settings(value: unknown): ProjectTriggerConfigDto {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    windowMinutes: integer(raw.windowMinutes, 0, 1440),
    maxAssets: integer(raw.maxAssets, 1, 5000),
    targetTypes: choices(raw.targetTypes, Object.values(TargetType)),
    workflows: Array.isArray(raw.workflows)
      ? raw.workflows.filter((v): v is string => typeof v === 'string')
      : undefined,
    status: choices(raw.status, ['success', 'failure'] as const),
    severity: choices(raw.severity, Object.values(Severity)),
  };
}

@Injectable()
export class ProjectTriggerReadService {
  constructor(private readonly dataSource: DataSource) {}
  async list(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectTriggerDto[]> {
    const [project] = await this.dataSource.query<{ id: string }[]>(
      'SELECT id FROM projects WHERE id = $1 AND "workspaceId" = $2',
      [projectId, workspaceId],
    );
    if (!project) throw new NotFoundException('Project not found');
    const rows = await this.dataSource.query<ProjectWorkflowTrigger[]>(
      `SELECT tr.id, tr."createdAt", tr."updatedAt", tr."projectWorkflowId", tr.type,
       tr.cron, tr.event, tr.config, tr.enabled, tr."lastFiredAt"
       FROM project_workflow_triggers tr
       JOIN project_workflows pw ON pw.id = tr."projectWorkflowId"
       JOIN projects p ON p.id = pw."projectId"
       JOIN workflows w ON w.id = pw."workflowId"
       WHERE p.id = $1 AND p."workspaceId" = $2 AND w."workspaceId" = $2
       ORDER BY tr."createdAt", tr.id`,
      [projectId, workspaceId],
    );
    return rows
      .filter((row) => row.type === 'cron' || row.type === 'event')
      .map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        projectWorkflowId: row.projectWorkflowId,
        type: row.type,
        cron: row.cron,
        event: PROJECT_TRIGGER_EVENTS.find((v) => v === row.event) ?? null,
        config: settings(row.config),
        enabled: row.enabled,
        lastFiredAt: row.lastFiredAt,
      }));
  }
}
