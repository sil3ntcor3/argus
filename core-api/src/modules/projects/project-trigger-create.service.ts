import { BadRequestException, Injectable } from '@nestjs/common';
import type { CreateProjectTriggerDto } from './dto/project-trigger-create.dto';
import type { ProjectTriggerDto } from './dto/project-trigger-read.dto';
import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { isTriggerEvent } from './project-trigger-config';

@Injectable()
export class ProjectTriggerCreateService {
  constructor(private readonly definitions: ProjectTriggerDefinitionService) {}
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
    const row = await this.definitions.createDisabled(
      projectId,
      workspaceId,
      dto.projectWorkflowId,
      definition,
    );
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
