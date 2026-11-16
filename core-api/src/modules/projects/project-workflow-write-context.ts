import { AssetGroupWorkflow } from '@/modules/asset-group/entities/asset-groups-workflows.entity';
import { isGroupOwnedWorkflow } from '@/modules/asset-group/workflow-ownership';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectArchivedException } from './project-archive-state';

/**
 * Lock an editable project-owned workflow and binding in parent-to-child order.
 * The caller owns the transaction and project-write permission check.
 */
export async function lockEditableProjectWorkflow(
  manager: EntityManager,
  projectId: string,
  workspaceId: string,
  bindingId: string,
): Promise<{ workflow: Workflow; binding: AssetGroupWorkflow }> {
  const result = await lockProjectWorkflow(manager, projectId, workspaceId, bindingId);
  if (!isGroupOwnedWorkflow(result.workflow, projectId.toLowerCase()) || !result.workflow.isCanEdit) {
    throw new BadRequestException('Workflow is not editable by this project');
  }
  return result;
}

/** Lock a binding without requiring ownership of its reusable definition. */
export async function lockProjectWorkflow(
  manager: EntityManager,
  projectId: string,
  workspaceId: string,
  bindingId: string,
): Promise<{ workflow: Workflow; binding: AssetGroupWorkflow }> {
  // Follow workspace deletion's parent-to-child lock order.
  await manager.query('SELECT id FROM workspaces WHERE id = $1 FOR KEY SHARE', [
    workspaceId,
  ]);
  const [project] = await manager.query<
    { id: string; archivedAt: Date | null }[]
  >(
    'SELECT id, "archivedAt" FROM projects WHERE id = $1 AND "workspaceId" = $2 FOR NO KEY UPDATE',
    [projectId, workspaceId],
  );
  if (!project) throw new NotFoundException('Project not found');
  if (project.archivedAt) throw new ProjectArchivedException();

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
  return { workflow, binding };
}
