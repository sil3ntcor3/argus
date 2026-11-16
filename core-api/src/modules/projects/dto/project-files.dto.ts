import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';

export class ProjectFileDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() mimeType: string;
  @ApiProperty() sizeBytes: number;
  @ApiProperty({ type: String, nullable: true }) createdByName: string | null;
  @ApiProperty({ type: Date }) attachedAt: Date;
}
export class PresignProjectFileDto {
  @ApiProperty({ maxLength: 255, description: '.md, .markdown, .txt or .csv' })
  @IsString() @IsNotEmpty() @MaxLength(255) fileName: string;
  @ApiProperty({ minimum: 1, maximum: 10485760 })
  @IsInt() @Min(1) @Max(10485760) sizeBytes: number;
}
export class PresignProjectFileResponseDto {
  @ApiProperty({ format: 'uuid' }) artifactId: string;
  @ApiProperty() url: string;
  @ApiProperty({ type: Object, additionalProperties: { type: 'string' } }) fields: Record<string, string>;
  @ApiProperty({ type: Date }) expiresAt: Date;
}
