import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

export class UpdateStorageQuotaDto {
  @ApiProperty({
    type: Number, nullable: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
    description: 'Quota in bytes. Null restores the default.',
  })
  @ValidateIf((dto: UpdateStorageQuotaDto) => dto.quotaBytes !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  quotaBytes: number | null;
}

export class WorkspaceStorageQuotaDto {
  @ApiProperty({ format: 'uuid' })
  workspaceId: string;

  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  quotaBytes: number | null;
}
