import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { isGroupOwnedWorkflow } from '@/modules/asset-group/workflow-ownership';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
import type { UpdateProjectWorkflowDto } from './dto/project-workflow-update.dto';

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
      // Follow workspace deletion's parent-to-child lock order.
      await manager.query(
        'SELECT id FROM workspaces WHERE id = $1 FOR KEY SHARE',
        [workspaceId],
      );
      const [project] = await manager.query<
        { id: string; archivedAt: Date | null }[]
      >(
        'SELECT id, "archivedAt" FROM projects WHERE id = $1 AND "workspaceId" = $2 FOR NO KEY UPDATE',
        [projectId, workspaceId],
      );
      if (!project) throw new NotFoundException('Project not found');
      if (project.archivedAt)
        throw new BadRequestException('Project is archived');

      const workflow = await manager
        .getRepository(Workflow)
        .createQueryBuilder('workflow')
        .innerJoin(
          AssetGroupWorkflow,
          'binding',
          'binding."workflowId" = workflow.id',
        )
        .where(
          'binding.id = :bindingId AND binding."projectId" = :projectId AND workflow."workspaceId" = :workspaceId',
          {
            bindingId,
            projectId,
            workspaceId,
          },
        )
        .setLock('pessimistic_write', undefined, ['workflow'])
        .getOne();
      if (!workflow) throw new NotFoundException('Project workflow not found');
      if (!isGroupOwnedWorkflow(workflow, project.id) || !workflow.isCanEdit) {
        throw new BadRequestException(
          'Workflow is not editable by this project',
        );
      }
      // Run creation and workflow deletion lock the workflow before its binding.
      const binding = await manager.findOne(AssetGroupWorkflow, {
        where: {
          id: bindingId,
          assetGroupId: projectId,
          workflowId: workflow.id,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!binding) throw new NotFoundException('Project workflow not found');
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
