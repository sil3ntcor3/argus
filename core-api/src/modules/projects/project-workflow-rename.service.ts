import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { isGroupOwnedWorkflow } from '@/modules/asset-group/workflow-ownership';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import type { RenameProjectWorkflowDto } from './dto/project-workflow-rename.dto';

@Injectable()
export class ProjectWorkflowRenameService {
  constructor(private readonly dataSource: DataSource) {}

  /** Rename both stored names under the same locks and transaction. */
  rename(
    projectId: string,
    workspaceId: string,
    bindingId: string,
    dto: RenameProjectWorkflowDto,
  ): Promise<AssetGroupWorkflow> {
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
      if (!isGroupOwnedWorkflow(workflow, projectId) || !workflow.isCanEdit) {
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
        name: dto.name,
        content: { ...workflow.content, name: dto.name },
      });
      return binding;
    });
  }
}
