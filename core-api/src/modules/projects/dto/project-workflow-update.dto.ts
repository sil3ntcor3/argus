import { ProjectWorkflowOnDto } from './project-workflow-on.dto';
import {
  ApiPropertyOptional,
  PartialType,
  getSchemaPath,
} from '@nestjs/swagger';
import { IsObject, ValidateIf } from 'class-validator';
import { WorkflowJob } from '@/modules/workflows/entities/workflow.entity';
import { RenameProjectWorkflowDto } from './project-workflow-rename.dto';

export class UpdateProjectWorkflowDto extends PartialType(
  RenameProjectWorkflowDto,
  { skipNullProperties: false },
) {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(WorkflowJob) },
    minProperties: 1,
    maxProperties: 50,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  jobs?: Record<string, WorkflowJob>;
  @ApiPropertyOptional({
    type: ProjectWorkflowOnDto,
    description:
      'Replace managed project trigger definitions; omit to preserve',
  })
  @ValidateIf((_dto, value: unknown) => value !== undefined)
  @IsObject()
  on?: ProjectWorkflowOnDto;
}
