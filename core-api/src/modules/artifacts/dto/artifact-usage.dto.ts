import { ApiProperty } from '@nestjs/swagger';

export class ArtifactUsageDto {
  @ApiProperty({ minimum: 0, description: 'Effective workspace quota in bytes' })
  quotaBytes: number;

  @ApiProperty({ minimum: 0, description: 'Bytes used by ready files' })
  usedBytes: number;

  @ApiProperty({ minimum: 0, description: 'Bytes reserved for pending uploads' })
  reservedBytes: number;

  @ApiProperty({ minimum: 0, description: 'Maximum size of one file in bytes' })
  maxFileBytes: number;
}
