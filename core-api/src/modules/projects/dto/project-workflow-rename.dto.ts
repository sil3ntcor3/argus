import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength, NotContains } from 'class-validator';

export class RenameProjectWorkflowDto {
  @ApiProperty({
    description: 'Trimmed workflow name',
    minLength: 1,
    maxLength: 120,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NotContains('\u0000')
  name: string;
}
