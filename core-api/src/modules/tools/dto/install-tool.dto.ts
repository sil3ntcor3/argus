import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { IdQueryParamDto } from '@/common/dtos/id-query-param.dto';
import { BaseEntity } from '@/common/entities/base.entity';
import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class InstallToolDto {
  // NOTE: `workspaceId` used to be accepted here and trusted as the tenant.
  // The tenant is now taken from the X-Workspace-ID header via @WorkspaceId(),
  // and the global ValidationPipe (whitelist: true) strips it from the body.
  @ApiProperty({
    description: 'The ID of the tool',
  })
  @IsUUID()
  toolId: string;
}

/** Minimal catalog identity returned by installation and used by its audit event. */
class InstalledToolIdentityDto extends IdQueryParamDto {
  @ApiProperty({ example: 'nuclei' })
  name: string;
}

/** Installation response; relations deliberately expose identities only. */
export class InstallToolResponseDto extends BaseEntity {
  @ApiProperty({ type: InstalledToolIdentityDto })
  tool: InstalledToolIdentityDto;

  @ApiProperty({ type: IdQueryParamDto })
  workspace: IdQueryParamDto;

  @ApiProperty()
  isEnabled: boolean;
}

/** Removed tool identity remains available after deleting its association. */
export class UninstallToolResponseDto extends DefaultMessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  toolId: string;

  @ApiProperty({ example: 'nuclei' })
  toolName: string;
}
