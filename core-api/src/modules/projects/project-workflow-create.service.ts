import { CronSchedule } from '@/common/enums/enum';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import {
  normalizeWorkflowContent,
  WorkflowGraphError,
} from '../workflows/workflow-graph';
import type {
  CreatedProjectWorkflowDto,
  CreateProjectWorkflowDto,
} from './dto/project-workflow-create.dto';

@Injectable()
export class ProjectWorkflowCreateService {
  constructor(private readonly dataSource: DataSource) {}

  create(
    projectId: string,
    workspaceId: string,
    dto: CreateProjectWorkflowDto,
  ): Promise<CreatedProjectWorkflowDto> {
    return this.dataSource.transaction(async (manager) => {
      // Match workspace deletion's parent-to-child lock order.
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

      const template = await manager.findOne(Workflow, {
        where: {
          filePath: dto.template,
          workspace: { id: workspaceId },
          isCanEdit: false,
        },
        select: { id: true, name: true, content: true },
      });
      if (!template) throw new NotFoundException('Workflow template not found');

      const name = dto.name?.trim() ?? template.name;
      let content: Workflow['content'];
      try {
        // Only copy the pipeline so template triggers cannot schedule this workflow.
        content = normalizeWorkflowContent({
          name,
          jobs: template.content.jobs,
        });
      } catch (error) {
        if (error instanceof WorkflowGraphError) {
          throw new BadRequestException(
            'Workflow template contains an invalid pipeline',
          );
        }
        throw error;
      }
      const workflow = await manager.save(Workflow, {
        name,
        content,
        workspace: { id: workspaceId },
        filePath: `project-${project.id}-${randomUUID()}.yaml`,
      });
      const binding = await manager.save(AssetGroupWorkflow, {
        assetGroupId: project.id,
        workflowId: workflow.id,
        schedule: CronSchedule.DISABLED,
        jobId: null,
      });
      return {
        id: binding.id,
        workflowId: workflow.id,
        name,
        schedule: CronSchedule.DISABLED,
      };
    });
  }
}
