import type { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { BadRequestException, Injectable } from '@nestjs/common';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
import type { UpdateProjectWorkflowDto } from './dto/project-workflow-update.dto';
import { lockEditableProjectWorkflow } from './project-workflow-write-context';

@Injectable()
export class ProjectWorkflowUpdateService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jobs: ProjectWorkflowJobsService,
    private readonly encryption: WorkspaceEncryptionService,
  ) {}

  /** Update the project pipeline and name under the run-launch lock order. */
  async update(
    projectId: string,
    workspaceId: string,
    bindingId: string,
    dto: UpdateProjectWorkflowDto,
  ): Promise<AssetGroupWorkflow> {
    if (dto.name === undefined && dto.jobs === undefined)
      throw new BadRequestException('Provide a name or pipeline');
    const dek =
      dto.jobs !== undefined ? await this.encryption.getDEK(workspaceId) : null;
    return this.dataSource.transaction(async (manager) => {
      const { workflow, binding } = await lockEditableProjectWorkflow(
        manager,
        projectId,
        workspaceId,
        bindingId,
      );
      binding.workflow = await manager.save(Workflow, {
        ...workflow,
        name: dto.name ?? workflow.name,
        content: {
          ...workflow.content,
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.jobs !== undefined
            ? {
                jobs: await this.jobs.prepare(
                  manager,
                  workspaceId,
                  dto.jobs,
                  workflow.content.jobs,
                  dek,
                ),
              }
            : {}),
        },
      });
      return binding;
    });
  }
}
