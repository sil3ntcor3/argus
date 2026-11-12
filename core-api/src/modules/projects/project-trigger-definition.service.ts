import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
        content: { ...workflow.content, on: on as Workflow['content']['on'] },
      });
      return manager.save(ProjectWorkflowTrigger, {
        projectWorkflowId: binding.id,
        type: trigger.type,
        cron: trigger.type === 'cron' ? trigger.cron : null,
        event: trigger.type === 'event' ? trigger.event : null,
        config: trigger.type === 'event' ? { ...trigger.config } : {},
        enabled: false,
        schedulerId: null,
        lastFiredAt: null,
      });
    });
  }
}
