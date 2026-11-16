import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import type { UpdateProjectTriggerDto } from './dto/project-trigger-update.dto';
import {
  enabledByKey,
  triggersOfInput,
  type WorkflowOnInput,
} from './project-workflow-on-input';
import { PROJECT_TRIGGER_EVENTS } from './dto/project-trigger-read.dto';
import { normalizeEventConfig, isTriggerEvent } from './project-trigger-config';
import { planTriggerSync } from './project-trigger-sync-plan';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import { keyOfRow } from './project-trigger-sync-plan';
import {
  onOfTriggers,
  triggersOfOn,
  WorkflowOnError,
} from './project-workflow-on';
import { lockEditableProjectWorkflow } from './project-workflow-write-context';

function definitions(on: unknown) {
  if (on !== undefined && (!on || typeof on !== 'object' || Array.isArray(on)))
    throw new BadRequestException('Trigger definitions must be a mapping');
  try {
    return triggersOfOn(on);
  } catch (error) {
    if (error instanceof WorkflowOnError)
      throw new BadRequestException(error.message);
    throw error;
  }
}

/** Private foundation; callers own project-write authorization. No scheduler I/O. */
@Injectable()
export class ProjectTriggerDefinitionService {
  constructor(private readonly dataSource: DataSource) {}

  async createDisabled(
    projectId: string,
    workspaceId: string,
    bindingId: string,
    definition: unknown,
  ): Promise<ProjectWorkflowTrigger> {
    return this.create(projectId, workspaceId, bindingId, definition, false);
  }

  async create(
    projectId: string,
    workspaceId: string,
    bindingId: string,
    definition: unknown,
    enabled = false,
  ): Promise<ProjectWorkflowTrigger> {
    const added = definitions(definition);
    if (added.length !== 1 || Object.hasOwn(definition as object, 'target'))
      throw new BadRequestException('Provide exactly one project trigger');
    const trigger = added[0];
    return this.dataSource.transaction(async (manager) => {
      const { workflow, binding } = await lockEditableProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      const existing = definitions(workflow.content.on);
      const rows = await manager.find(ProjectWorkflowTrigger, {
        where: { projectWorkflowId: binding.id },
      });
      if (
        existing.some((t) => t.key === trigger.key) ||
        rows.some((r) => keyOfRow(r) === trigger.key)
      )
        throw new BadRequestException('This workflow already has this trigger');
      // Preserve unrelated authored event settings and legacy target data verbatim.
      const on = {
        ...workflow.content.on,
        ...onOfTriggers(
          trigger.type === 'cron'
            ? [...existing.filter((t) => t.type === 'cron'), trigger]
            : [trigger],
        ),
      };
      await manager.save(Workflow, {
        ...workflow,
        content: { ...workflow.content, on: on },
      });
      return manager.save(ProjectWorkflowTrigger, {
        projectWorkflowId: binding.id,
        type: trigger.type,
        cron: trigger.type === 'cron' ? trigger.cron : null,
        event: trigger.type === 'event' ? trigger.event : null,
        config: trigger.type === 'event' ? { ...trigger.config } : {},
        enabled,
        schedulerId: null,
        lastFiredAt: null,
      });
    });
  }
  async bindingOf(
    projectId: string,
    workspaceId: string,
    triggerId: string,
  ): Promise<string> {
    const [row] = await this.dataSource.query<{ id: string }[]>(
      `SELECT pw.id FROM project_workflow_triggers tr
       JOIN project_workflows pw ON pw.id=tr."projectWorkflowId"
       JOIN projects p ON p.id=pw."projectId"
       JOIN workflows w ON w.id=pw."workflowId"
       WHERE tr.id=$1 AND p.id=$2 AND p."workspaceId"=$3 AND w."workspaceId"=$3`,
      [triggerId, projectId, workspaceId],
    );
    if (!row) throw new NotFoundException('Project trigger not found');
    return row.id;
  }

  async update(
    projectId: string,
    workspaceId: string,
    triggerId: string,
    patch: UpdateProjectTriggerDto,
  ): Promise<ProjectWorkflowTrigger> {
    if (
      patch.cron === undefined &&
      patch.config === undefined &&
      patch.enabled === undefined
    )
      throw new BadRequestException('Provide a trigger setting');
    const bindingId = await this.bindingOf(projectId, workspaceId, triggerId);
    return this.dataSource.transaction(async (manager) => {
      const { workflow, binding } = await lockEditableProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      const rows = await manager.find(ProjectWorkflowTrigger, {
        where: { projectWorkflowId: binding.id },
      });
      const row = rows.find((r) => r.id === triggerId);
      if (!row) throw new NotFoundException('Project trigger not found');
      if (
        (row.type === 'cron' && patch.config !== undefined) ||
        (row.type === 'event' && patch.cron !== undefined)
      )
        throw new BadRequestException(
          'Provide only the fields for this trigger type',
        );
      const oldKey = keyOfRow(row);
      if (!oldKey || (row.type === 'event' && !isTriggerEvent(row.event)))
        throw new BadRequestException('Invalid stored trigger');
      const [next] = definitions(
        row.type === 'cron'
          ? { schedule: patch.cron ?? row.cron }
          : {
              [row.event!]: {
                ...normalizeEventConfig(
                  row.event as (typeof PROJECT_TRIGGER_EVENTS)[number],
                  row.config,
                ),
                ...patch.config,
              },
            },
      );
      const current = definitions(workflow.content.on);
      if (
        next.key !== oldKey &&
        (current.some((t) => t.key === next.key) ||
          rows.some((r) => r.id !== row.id && keyOfRow(r) === next.key))
      )
        throw new BadRequestException('This workflow already has this trigger');
      const wanted = current.filter((t) => t.key !== oldKey);
      wanted.push(next);
      await manager.save(Workflow, {
        ...workflow,
        content: {
          ...workflow.content,
          on: managedOn(workflow.content.on, wanted),
        },
      });
      return manager.save(ProjectWorkflowTrigger, {
        ...row,
        cron: next.type === 'cron' ? next.cron : null,
        config: next.type === 'event' ? { ...next.config } : {},
        enabled: patch.enabled ?? row.enabled,
      });
    });
  }

  async remove(
    projectId: string,
    workspaceId: string,
    triggerId: string,
  ): Promise<string> {
    const bindingId = await this.bindingOf(projectId, workspaceId, triggerId);
    await this.dataSource.transaction(async (manager) => {
      const { workflow, binding } = await lockEditableProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      const row = await manager.findOne(ProjectWorkflowTrigger, {
        where: { id: triggerId, projectWorkflowId: binding.id },
      });
      if (!row) throw new NotFoundException('Project trigger not found');
      const wanted = definitions(workflow.content.on).filter(
        (t) => t.key !== keyOfRow(row),
      );
      await manager.save(Workflow, {
        ...workflow,
        content: {
          ...workflow.content,
          on: managedOn(workflow.content.on, wanted),
        },
      });
      await manager.delete(ProjectWorkflowTrigger, { id: row.id });
    });
    return bindingId;
  }

  /** Called inside an existing workflow-write transaction, after parent locks. */
  async replaceOn(
    manager: EntityManager,
    workflow: Workflow,
    binding: AssetGroupWorkflow,
    input: WorkflowOnInput,
  ): Promise<Workflow> {
    let wanted: ReturnType<typeof triggersOfInput>,
      activation: Map<string, boolean>;
    try {
      wanted = triggersOfInput(input);
      activation = enabledByKey(input);
    } catch (error) {
      if (error instanceof WorkflowOnError)
        throw new BadRequestException(error.message);
      throw error;
    }
    const rows = await manager.find(ProjectWorkflowTrigger, {
      where: { projectWorkflowId: binding.id },
    });
    const plan = planTriggerSync(rows, wanted);
    if (plan.remove.length)
      await manager.delete(
        ProjectWorkflowTrigger,
        plan.remove.map((r) => r.id),
      );
    for (const item of wanted) {
      const row = rows.find(
        (r) => keyOfRow(r) === item.key && !plan.remove.includes(r),
      );
      await manager.save(ProjectWorkflowTrigger, {
        ...(row ?? {
          projectWorkflowId: binding.id,
          schedulerId: null,
          lastFiredAt: null,
        }),
        type: item.type,
        cron: item.type === 'cron' ? item.cron : null,
        event: item.type === 'event' ? item.event : null,
        config: item.type === 'event' ? { ...item.config } : {},
        enabled: activation.get(item.key) ?? row?.enabled ?? false,
      });
    }
    return manager.save(Workflow, {
      ...workflow,
      content: {
        ...workflow.content,
        on: managedOn(workflow.content.on, wanted),
      },
    });
  }
}

function managedOn(
  on: Workflow['content']['on'],
  wanted: ReturnType<typeof triggersOfOn>,
): Workflow['content']['on'] {
  const retained = Object.fromEntries(
    Object.entries(on ?? {}).filter(
      ([key]) =>
        key !== 'schedule' &&
        !PROJECT_TRIGGER_EVENTS.some((event) => event === key),
    ),
  );
  const next = { ...retained, ...onOfTriggers(wanted) };
  return Object.keys(next).length ? next : undefined;
}
