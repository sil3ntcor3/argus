import type { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';
import type { UpdateProjectTriggerDto } from './dto/project-trigger-update.dto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';
import type { ProjectTriggerDto } from './dto/project-trigger-read.dto';
import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { isTriggerEvent } from './project-trigger-config';

@Injectable()
export class ProjectTriggerCreateService {
  constructor(private readonly definitions: ProjectTriggerDefinitionService, private readonly runtime: ProjectTriggerRuntimeService) {}
  async create(
    projectId: string,
    workspaceId: string,
    dto: CreateProjectTriggerDto,
  ): Promise<ProjectTriggerDto> {
    let definition: object;
    if (
      dto.type === 'cron' &&
      dto.event === undefined &&
      dto.config === undefined
    )
      definition = { schedule: dto.cron };
    else if (dto.type === 'event' && dto.cron === undefined)
      definition = { [dto.event ?? '']: dto.config ?? {} };
    else
      throw new BadRequestException(
        'Provide only the fields for the selected trigger type',
      );
    const args = [projectId, workspaceId, dto.projectWorkflowId, definition] as const;
    const row = dto.enabled === undefined
      ? await this.definitions.createDisabled(...args)
      : await this.definitions.create(...args, dto.enabled);
    await this.runtime.reconcile();
    return this.publicRow(row);
  }
  async update(projectId: string, workspaceId: string, triggerId: string, patch: UpdateProjectTriggerDto): Promise<ProjectTriggerDto> {
    const row = await this.definitions.update(projectId, workspaceId, triggerId, patch);
    if (!row.enabled) await this.runtime.clear(triggerId);
    await this.runtime.reconcile();
    return this.publicRow(row);
  }
  async remove(projectId: string, workspaceId: string, triggerId: string) {
    await this.definitions.remove(projectId, workspaceId, triggerId);
    await this.runtime.clear(triggerId);
    await this.runtime.reconcile();
    return { message: 'Trigger removed' };
  }
  private publicRow(row: ProjectWorkflowTrigger): ProjectTriggerDto {
    // The writer validates configuration; explicitly whitelist public row fields.
    return {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      projectWorkflowId: row.projectWorkflowId,
      type: row.type,
      cron: row.cron,
      event: isTriggerEvent(row.event) ? row.event : null,
      config: row.config,
      enabled: row.enabled,
      lastFiredAt: row.lastFiredAt,
    };
  }
}
