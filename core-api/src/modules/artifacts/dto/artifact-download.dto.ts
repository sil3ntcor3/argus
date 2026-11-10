import { ApiProperty } from '@nestjs/swagger';

export class ArtifactDownloadDto {
  @ApiProperty({ description: 'Signed URL for the attachment' })
  url: string;

  @ApiProperty({ description: 'Lifetime of the signed URL in seconds', example: 300 })
  expiresIn: number;
}
