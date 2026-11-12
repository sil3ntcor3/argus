import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';
import { CronSchedule } from '@/common/enums/enum';
import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { ProjectWorkflowJobsService } from './project-workflow-jobs.service';
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
  constructor(
    private readonly dataSource: DataSource,
    private readonly jobs: ProjectWorkflowJobsService,
    private readonly encryption: WorkspaceEncryptionService,
    private readonly triggers: ProjectTriggerDefinitionService,
  ) {}

  async create(
    projectId: string,
    workspaceId: string,
    dto: CreateProjectWorkflowDto,
  ): Promise<CreatedProjectWorkflowDto> {
    if (
      [dto.template, dto.jobs, dto.copyFromProjectWorkflowId].filter(
        (source) => source !== undefined,
      ).length !== 1
    )
      throw new BadRequestException(
        'Provide exactly one of template, jobs or copyFromProjectWorkflowId',
      );
    // Resolve the key before holding transaction locks or a pooled connection.
    const dek =
      dto.jobs !== undefined ? await this.encryption.getDEK(workspaceId) : null;
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

      const template =
        dto.template !== undefined
          ? await manager.findOne(Workflow, {
              where: {
                filePath: dto.template,
                workspace: { id: workspaceId },
                isCanEdit: false,
              },
              select: { id: true, name: true, content: true },
            })
          : null;
      if (dto.template !== undefined && !template)
        throw new NotFoundException('Workflow template not found');

      const copied =
        dto.copyFromProjectWorkflowId !== undefined
          ? (
              await manager.findOne(AssetGroupWorkflow, {
                where: {
                  id: dto.copyFromProjectWorkflowId,
                  assetGroup: { workspace: { id: workspaceId } },
                  workflow: { workspace: { id: workspaceId } },
                },
                relations: { workflow: true },
                select: {
                  id: true,
                  workflow: { id: true, name: true, content: true },
                },
              })
            )?.workflow
          : null;
      if (dto.copyFromProjectWorkflowId !== undefined && !copied)
        throw new NotFoundException('Source project workflow not found');

      const name =
        dto.name?.trim() ??
        (copied
          ? `${copied.name} (copy)`
          : (template?.name ?? 'Project workflow'));
      const jobs =
        dto.jobs !== undefined
          ? await this.jobs.prepare(manager, workspaceId, dto.jobs, {}, dek)
          : (copied ?? template)!.content.jobs;
      let content: Workflow['content'];
      try {
        // Only copy the pipeline so template triggers cannot schedule this workflow.
        content = normalizeWorkflowContent({
          name,
          jobs,
        });
      } catch (error) {
        if (error instanceof WorkflowGraphError) {
          throw new BadRequestException(
            copied
              ? 'Source workflow contains an invalid pipeline'
              : 'Workflow template contains an invalid pipeline',
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
      if (dto.on !== undefined) await this.triggers.replaceOn(manager, workflow, binding, dto.on);
      return {
        id: binding.id,
        workflowId: workflow.id,
        name,
        schedule: CronSchedule.DISABLED,
      };
    });
  }
}
