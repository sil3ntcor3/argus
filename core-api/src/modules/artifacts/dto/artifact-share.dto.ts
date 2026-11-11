import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail } from 'class-validator';

export class AddArtifactSharesDto {
  @ApiProperty({ type: [String], maxItems: 50, example: ['member@example.com'] })
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? (value as unknown[]).map(email => typeof email === 'string' ? email.trim().toLowerCase() : email)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  emails: string[];
}

export class AddArtifactSharesResultDto {
  @ApiProperty({ description: 'Current workspace recipients matched, including existing shares.' })
  shared: number;

  @ApiProperty({ description: 'Distinct addresses that did not match an eligible recipient.' })
  skipped: number;
}
