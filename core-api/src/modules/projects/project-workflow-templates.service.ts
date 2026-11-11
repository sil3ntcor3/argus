import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { jobEntries, normalizeNeeds } from '../workflows/workflow-graph';
import type { WorkflowTemplateDto } from './dto/project-workflow-template.dto';

@Injectable()
export class ProjectWorkflowTemplatesService {
  constructor(private readonly dataSource: DataSource) {}

  /** Lists owned defaults as dependency outlines, excluding configuration and secrets. */
  async list(workspaceId: string): Promise<WorkflowTemplateDto[]> {
    const workflows = await this.dataSource.getRepository(Workflow).find({
      where: { workspace: { id: workspaceId }, isCanEdit: false },
      select: { filePath: true, name: true, content: true },
      order: { name: 'ASC', filePath: 'ASC', id: 'ASC' },
    });
    return workflows.map((workflow) => ({
      filePath: workflow.filePath,
      name: workflow.name,
      jobs: jobEntries(workflow.content?.jobs).map(([id, job]) => ({
        id,
        run: job.run,
        needs: normalizeNeeds(job.needs),
      })),
    }));
  }
}
