import { REVIEW_STATUSES, type ReviewStatus } from '@/modules/vulnerabilities/dto/vulnerability-review.dto';
import type { VulnerabilityDetectionStatus } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import {
  IssueLinkResourceType,
  Severity,
} from '@/common/enums/enum';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class IssueLinkInputDto {
  @ApiProperty({ enum: IssueLinkResourceType })
  @IsEnum(IssueLinkResourceType)
  resourceType: IssueLinkResourceType;

  @ApiProperty()
  @IsUUID()
  resourceId: string;
}

export class AddIssueLinksDto {
  @ApiProperty({ type: [IssueLinkInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => IssueLinkInputDto)
  links: IssueLinkInputDto[];
}

/**
 * The linked resource, summarised for the issue page. Only the fields of its
 * own kind are set; `missing` means the resource has since been deleted (links
 * carry no foreign key).
 */
export class IssueLinkResourceSummaryDto {
  @ApiProperty({ required: false, description: 'Resource no longer exists' })
  missing?: boolean;

  @ApiProperty({ required: false, description: 'Vulnerability name / project name' })
  name?: string;

  @ApiProperty({ required: false, description: 'Asset or target value' })
  value?: string;

  @ApiProperty({ required: false, enum: Severity })
  severity?: Severity;

  @ApiProperty({ required: false, enum: ['new', 'active', 'fixed', 'resurfaced'] })
  detectionStatus?: VulnerabilityDetectionStatus;

  @ApiProperty({ required: false, enum: REVIEW_STATUSES })
  reviewStatus?: ReviewStatus;

  @ApiProperty({ required: false, description: 'Asset of the vulnerability' })
  assetValue?: string;

  @ApiProperty({ required: false, nullable: true, type: Date })
  dueAt?: Date | null;

  @ApiProperty({ required: false, description: 'Dismissal in effect' })
  dismissed?: boolean;

  @ApiProperty({ required: false, description: 'Run status: running | completed' })
  status?: string;

  @ApiProperty({ required: false, type: Date })
  createdAt?: Date;
}

export class IssueLinkDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: IssueLinkResourceType })
  resourceType: IssueLinkResourceType;

  @ApiProperty()
  resourceId: string;

  @ApiProperty({ nullable: true, type: String })
  addedById: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ type: () => IssueLinkResourceSummaryDto })
  resource: IssueLinkResourceSummaryDto;
}
