import { Severity, TargetType } from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';

export const PROJECT_TRIGGER_EVENTS = [
  'project.assets.added',
  'project.run.completed',
  'vulnerability.detected',
] as const;

export class ProjectTriggerConfigDto {
  @ApiProperty({ required: false, minimum: 0, maximum: 1440 })
  windowMinutes?: number;
  @ApiProperty({ required: false, minimum: 1, maximum: 5000 })
  maxAssets?: number;
  @ApiProperty({
    required: false,
    enum: TargetType,
    enumName: 'TargetType',
    isArray: true,
  })
  targetTypes?: TargetType[];
  @ApiProperty({ required: false, type: [String] }) workflows?: string[];
  @ApiProperty({ required: false, enum: ['success', 'failure'], isArray: true })
  status?: ('success' | 'failure')[];
  @ApiProperty({
    required: false,
    enum: Severity,
    enumName: 'Severity',
    isArray: true,
  })
  severity?: Severity[];
}

export class ProjectTriggerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: Date }) createdAt: Date;
  @ApiProperty({ type: Date }) updatedAt: Date;
  @ApiProperty({ format: 'uuid' }) projectWorkflowId: string;
  @ApiProperty({ enum: ['cron', 'event'], enumName: 'ProjectTriggerType' })
  type: 'cron' | 'event';
  @ApiProperty({ type: String, nullable: true }) cron: string | null;
  @ApiProperty({
    enum: PROJECT_TRIGGER_EVENTS,
    enumName: 'ProjectTriggerEvent',
    nullable: true,
  })
  event: (typeof PROJECT_TRIGGER_EVENTS)[number] | null;
  @ApiProperty({ type: ProjectTriggerConfigDto })
  config: ProjectTriggerConfigDto;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: Date, nullable: true }) lastFiredAt: Date | null;
}
