import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import { ApiProperty } from '@nestjs/swagger';

export class RetryRunResponseDto extends DefaultMessageResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  jobHistoryId: string;
}
