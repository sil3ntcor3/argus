import {
  IssuePriority,
  IssueResolution,
  IssueStatus,
  IssueType,
} from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  ValidateIf,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IssueLinkDto, IssueLinkInputDto } from './issue-link.dto';

export class CreateIssueDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  title: string;

  @ApiProperty({ required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  description?: string;

  @ApiProperty({ enum: IssueType, required: false, default: IssueType.TASK })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(IssueType)
  type?: IssueType;

  @ApiProperty({ enum: IssuePriority, required: false, default: IssuePriority.P3 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(IssuePriority)
  priority?: IssuePriority;

  @ApiProperty({ required: false, nullable: true, type: Date })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueAt?: Date | null;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;

  @ApiProperty({ type: [String], required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ type: [IssueLinkInputDto], required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => IssueLinkInputDto)
  links?: IssueLinkInputDto[];
}

/** Every field optional; `null` clears dueAt / assignee. */
export class UpdateIssueDto {
  @ApiProperty({ required: false, maxLength: 500 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  title?: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({ type: [String], required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ enum: IssuePriority, required: false })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(IssuePriority)
  priority?: IssuePriority;

  @ApiProperty({ required: false, nullable: true, type: Date })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueAt?: Date | null;

  @ApiProperty({ required: false, nullable: true, type: String })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;
}

export class ChangeIssueStatusDto {
  @ApiProperty({ enum: IssueStatus })
  @IsEnum(IssueStatus)
  status: IssueStatus;

  @ApiProperty({
    enum: IssueResolution,
    required: false,
    description: 'Required when the status is resolved or closed',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(IssueResolution)
  resolution?: IssueResolution;

  @ApiProperty({ required: false, description: 'Note added to the system comment' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** A user as responses expose them: id, name and image only. */
export class IssueUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  name: string;

  @ApiProperty({ required: false, nullable: true, type: String })
  image?: string | null;
}

export class IssueProgressDto {
  @ApiProperty()
  done: number;

  @ApiProperty()
  total: number;
}

export class IssueListItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  no: number;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  title: string;

  @ApiProperty({ enum: IssueType })
  type: IssueType;

  @ApiProperty({ enum: IssueStatus })
  status: IssueStatus;

  @ApiProperty({ enum: IssuePriority })
  priority: IssuePriority;

  @ApiProperty({ enum: IssueResolution, nullable: true })
  resolution: IssueResolution | null;

  @ApiProperty({ nullable: true, type: Date })
  dueAt: Date | null;

  @ApiProperty({ nullable: true, type: Date })
  resolvedAt: Date | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ nullable: true, type: String })
  ruleId: string | null;

  @ApiProperty({ type: () => IssueUserDto, nullable: true })
  assignee: IssueUserDto | null;

  @ApiProperty({ type: () => IssueUserDto, nullable: true })
  createdBy: IssueUserDto | null;

  @ApiProperty()
  linkCount: number;

  @ApiProperty({ type: () => IssueProgressDto, nullable: true })
  progress: IssueProgressDto | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class IssueDetailDto extends IssueListItemDto {
  @ApiProperty({ nullable: true, type: String })
  description: string | null;

  @ApiProperty({ nullable: true, type: String })
  groupKey: string | null;

  @ApiProperty({ type: [IssueLinkDto] })
  links: IssueLinkDto[];
}
