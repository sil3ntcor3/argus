import { ApiProperty } from '@nestjs/swagger';

export class WorkflowTemplateJobDto {
  @ApiProperty() id: string;
  @ApiProperty() run: string;
  @ApiProperty({ type: [String] }) needs: string[];
}

export class WorkflowTemplateDto {
  @ApiProperty() filePath: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: [WorkflowTemplateJobDto] })
  jobs: WorkflowTemplateJobDto[];
}
