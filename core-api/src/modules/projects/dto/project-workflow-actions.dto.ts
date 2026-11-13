import { AssetGroupLastRunDto } from '@/modules/asset-group/dto/asset-group-last-run.dto';
import { WorkflowContent } from '@/modules/workflows/entities/workflow.entity';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { ProjectTriggerDto } from './project-trigger-read.dto';

export class ProjectWorkflowViewDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() filePath: string;
  @ApiProperty({ type: Date }) createdAt: Date;
  @ApiProperty({ type: Date }) updatedAt: Date;
  @ApiProperty() isCanEdit: boolean;
  @ApiProperty() isCanDelete: boolean;
  @ApiProperty({ type: WorkflowContent }) content: WorkflowContent;
}

export class ProjectWorkflowBindingDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) projectId: string;
  @ApiProperty({ format: 'uuid' }) workflowId: string;
  @ApiProperty({ type: Date }) createdAt: Date;
  @ApiProperty({ type: Date }) updatedAt: Date;
  @ApiProperty() schedule: string;
  @ApiProperty({ type: ProjectWorkflowViewDto })
  workflow: ProjectWorkflowViewDto;
  @ApiProperty({ type: [ProjectTriggerDto] }) triggers: ProjectTriggerDto[];
  @ApiProperty({ type: AssetGroupLastRunDto, nullable: true })
  lastRun: AssetGroupLastRunDto | null;
}

export class RunProjectWorkflowDto {
  @ApiProperty({
    required: false,
    type: [String],
    minItems: 1,
    maxItems: 5000,
    uniqueItems: true,
    format: 'uuid',
  })
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((id: unknown) =>
          typeof id === 'string' ? id.toLowerCase() : id,
        )
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assetIds?: string[];
}

export class ProjectWorkflowRunReceiptDto {
  @ApiProperty({ format: 'uuid' }) jobHistoryId: string;
  @ApiProperty() assets: number;
}

export class ProjectWorkflowRemovedDto {
  @ApiProperty() message: string;
  @ApiProperty() name: string;
}
