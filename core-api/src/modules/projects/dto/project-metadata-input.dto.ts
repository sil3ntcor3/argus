import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
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
