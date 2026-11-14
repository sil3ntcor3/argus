import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  NotContains,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { WorkflowJob } from '@/modules/workflows/entities/workflow.entity';
import { ScopeRuleInputDto } from './project-scope-preview.dto';
import { ProjectWorkflowOnDto } from './project-workflow-on.dto';
import { CreateAssetGroupDto } from '@/modules/asset-group/dto/create-asset-group.dto';
import { UpdateAssetGroupDto } from '@/modules/asset-group/dto/update-asset-group.dto';

class ProjectMetadataInputDto {
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instruction?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ required: false, type: Boolean })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  autoAddAssets?: boolean;
}

export class CreateProjectDto extends IntersectionType(
  CreateAssetGroupDto,
  ProjectMetadataInputDto,
) {
  @ApiProperty({ description: 'Name of the project', maxLength: 120 })
  @MaxLength(120)
  declare name: string;

  @ApiPropertyOptional({ type: [ScopeRuleInputDto], maxItems: 100 })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ScopeRuleInputDto)
  scopeRules?: ScopeRuleInputDto[];

  @ApiPropertyOptional({
    maxLength: 255,
    description:
      'Workspace default workflow filename; one initial pipeline source',
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @NotContains('\u0000')
  @MaxLength(255)
  template?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/\S/)
  @NotContains('\u0000')
  @MaxLength(120)
  workflowName?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(WorkflowJob) },
    minProperties: 1,
    maxProperties: 50,
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  jobs?: Record<string, WorkflowJob>;

  @ApiPropertyOptional({
    type: ProjectWorkflowOnDto,
    description: 'Explicit managed triggers; new entries default disabled',
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsObject()
  on?: ProjectWorkflowOnDto;

  @ApiPropertyOptional({ default: false })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsBoolean()
  runNow?: boolean;
}

export class UpdateProjectDto extends IntersectionType(
  UpdateAssetGroupDto,
  ProjectMetadataInputDto,
) {
  @ApiProperty({
    required: false,
    description: 'Name of the project',
    maxLength: 120,
  })
  @MaxLength(120)
  declare name?: string;

  @ApiProperty({ required: false, pattern: '^#[0-9a-fA-F]{6}$' })
  @Matches(/^#[0-9a-fA-F]{6}$/)
  declare hexColor?: string;
}
