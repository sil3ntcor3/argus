import {
  IssuePriority,
  IssueRuleGroupBy,
  IssueType,
  Severity,
} from '@/common/enums/enum';
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Events a rule can run on. */
export const ISSUE_RULE_EVENTS = [
  'vulnerability.detected',
  'vulnerability.resurfaced',
] as const;
export type IssueRuleEvent = (typeof ISSUE_RULE_EVENTS)[number];

export class IssueRuleConditionsDto {
  @ApiProperty({ enum: Severity, required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(Severity)
  minSeverity?: Severity;

  @ApiProperty({ required: false, minimum: 0, maximum: 1 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber()
  @Min(0)
  @Max(1)
  minEpss?: number;

  @ApiProperty({ type: [String], required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @IsUUID('all', { each: true })
  targetIds?: string[];
}

export class CreateIssueRuleDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  name: string;

  @ApiProperty({ required: false, default: true })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ enum: ISSUE_RULE_EVENTS })
  @IsIn(ISSUE_RULE_EVENTS)
  event: IssueRuleEvent;

  @ApiProperty({ type: () => IssueRuleConditionsDto, required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => IssueRuleConditionsDto)
  conditions?: IssueRuleConditionsDto;

  @ApiProperty({
    enum: [IssueType.VULNERABILITY_REMEDIATION],
    description: 'Rules open vulnerability remediation issues only, for now',
  })
  @IsIn([IssueType.VULNERABILITY_REMEDIATION])
  issueType: IssueType;

  @ApiProperty({ enum: IssueRuleGroupBy, required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(IssueRuleGroupBy)
  groupBy?: IssueRuleGroupBy;

  @ApiProperty({
    enum: IssuePriority,
    required: false,
    nullable: true,
    description: 'Fixed priority; null derives it from the severity',
  })
  @IsOptional()
  @IsEnum(IssuePriority)
  priority?: IssuePriority | null;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsUUID()
  defaultAssigneeId?: string | null;
}

export class UpdateIssueRuleDto extends PartialType(CreateIssueRuleDto, { skipNullProperties: false }) {}

export class IssueRuleDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  name: string;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ enum: ISSUE_RULE_EVENTS })
  event: string;

  @ApiProperty({ type: () => IssueRuleConditionsDto })
  conditions: IssueRuleConditionsDto;

  @ApiProperty({ enum: IssueType })
  issueType: IssueType;

  @ApiProperty({ enum: IssueRuleGroupBy })
  groupBy: IssueRuleGroupBy;

  @ApiProperty({ enum: IssuePriority, nullable: true })
  priority: IssuePriority | null;

  @ApiProperty({ nullable: true, type: String })
  defaultAssigneeId: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
