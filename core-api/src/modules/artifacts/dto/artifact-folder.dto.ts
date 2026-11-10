import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ArtifactFolderQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Parent folder ID. Omit for the workspace root.' })
  @IsOptional()
  @IsUUID()
  parentFolderId?: string;
}

export class ArtifactFolderPathItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;
}

export class ArtifactFolderDto extends ArtifactFolderPathItemDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  parentFolderId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class ArtifactFolderDetailDto extends ArtifactFolderDto {
  @ApiProperty({ type: [ArtifactFolderPathItemDto], description: 'Breadcrumb from the root folder to this folder.' })
  path: ArtifactFolderPathItemDto[];
}
