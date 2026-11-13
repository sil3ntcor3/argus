import { vulnerabilitySettingsChanges } from './vulnerability-settings';
import { UserContext } from '@/common/decorators/app.decorator';
import { WorkspaceId } from '@/common/decorators/workspace-id.decorator';
import { WorkspaceAccess } from '@/common/decorators/workspace-access.decorator';
import { Doc } from '@/common/doc/doc.decorator';
import { DefaultMessageResponseDto } from '@/common/dtos/default-message-response.dto';
import type { RequestWithMetadata } from '@/common/interfaces/app.interface';
import { GetManyResponseDto } from '@/utils/getManyResponse';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { User } from '../auth/entities/user.entity';
import { AnalyzeVulnerabilityDto } from './dto/analyze-vulnerability.dto';
import {
  BulkDismissVulnerabilitiesDto,
  BulkReopenVulnerabilitiesDto,
  ClaimFixDto,
  ClaimFixResponseDto,
} from './dto/bulk-vulnerability.dto';
import {
  GetVulnerabilitiesStatisticsQueryDto,
  GetVulnerabilitiesStatisticsResponseDto,
} from './dto/get-vulnerability-statistics.dto';
import { GetVulnerabilitiesQueryDto } from './dto/get-vulnerability.dto';
import { ScanDto } from './dto/scan.dto';
import { VulnerabilityTimelineResponseDto } from './dto/vulnerability-timeline.dto';
import { VulnerabilityDismissal } from './entities/vulnerability-dismissal.entity';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import { PublishEvent } from '../event-bridge/publishing/publish-event.decorator';
import { VulnerabilitiesService } from './vulnerabilities.service';
import { VulnerabilityLifecycleService } from './vulnerability-lifecycle.service';
import { UpdateVulnerabilitySettingsDto, VulnerabilitySettingsDto } from './dto/vulnerability-settings.dto';
import { VulnerabilityLifecycleDto, VulnerabilityLifecycleDetailDto } from './dto/vulnerability-lifecycle.dto';
import { VulnerabilityReviewService } from './vulnerability-review.service';
import { bulkReviewAuditMetadata, mergeReviewAuditMetadata } from './vulnerability-review-audit';
import { ApproveVulnerabilityDto, RejectVulnerabilityDto, MergeVulnerabilityDto, BulkApproveVulnerabilitiesDto, BulkRejectVulnerabilitiesDto, BulkReviewResultDto, VulnerabilityReviewResultDto, MergeVulnerabilityResponseDto, VulnerabilityDuplicatesResponseDto } from './dto/vulnerability-review.dto';

@Controller('vulnerabilities')
export class VulnerabilitiesController {
  constructor(
    private readonly vulnerabilitiesService: VulnerabilitiesService,
    private readonly lifecycleService: VulnerabilityLifecycleService,
    private readonly reviewService: VulnerabilityReviewService,
  ) {}

  @Doc({ summary: 'Approve pending finding proposals', response: { serialization: BulkReviewResultDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.write')
  @PublishEvent(EVENT_CATALOG.vulnerability.review.approved, { metadata: bulkReviewAuditMetadata })
  @Post('review/approve') @HttpCode(HttpStatus.OK)
  bulkApprove(@Body() dto: BulkApproveVulnerabilitiesDto, @UserContext() user: User, @WorkspaceId() workspaceId: string) {
    return this.reviewService.bulk(dto.ids, id => this.reviewService.approve(id, { note: dto.note }, user.id, workspaceId));
  }

  @Doc({ summary: 'Reject pending finding proposals', response: { serialization: BulkReviewResultDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.write')
  @PublishEvent(EVENT_CATALOG.vulnerability.review.rejected, { metadata: bulkReviewAuditMetadata })
  @Post('review/reject') @HttpCode(HttpStatus.OK)
  bulkReject(@Body() dto: BulkRejectVulnerabilitiesDto, @UserContext() user: User, @WorkspaceId() workspaceId: string) {
    return this.reviewService.bulk(dto.ids, id => this.reviewService.reject(id, dto, user.id, workspaceId));
  }

  @Doc({ summary: 'Approve a pending finding proposal', response: { serialization: VulnerabilityReviewResultDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.write')
  @PublishEvent(EVENT_CATALOG.vulnerability.review.approved, { resourceIdFromRoute: true })
  @Post(':id/review/approve') @HttpCode(HttpStatus.OK)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveVulnerabilityDto, @UserContext() user: User, @WorkspaceId() workspaceId: string) {
    return this.reviewService.approve(id,dto,user.id,workspaceId);
  }

  @Doc({ summary: 'Reject a pending finding proposal', response: { serialization: VulnerabilityReviewResultDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.write')
  @PublishEvent(EVENT_CATALOG.vulnerability.review.rejected, { resourceIdFromRoute: true })
  @Post(':id/review/reject') @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectVulnerabilityDto, @UserContext() user: User, @WorkspaceId() workspaceId: string) {
    return this.reviewService.reject(id,dto,user.id,workspaceId);
  }

  @Doc({ summary: 'Merge a pending proposal into an approved finding', response: { serialization: MergeVulnerabilityResponseDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.write')
  @PublishEvent(EVENT_CATALOG.vulnerability.review.merged, { resourceIdFromRoute: true,
    metadata: (body, result) => ({ ...mergeReviewAuditMetadata(body), movedSources: (result as MergeVulnerabilityResponseDto)?.movedSources ?? 0 }) })
  @Post(':id/review/merge') @HttpCode(HttpStatus.OK)
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeVulnerabilityDto, @UserContext() user: User, @WorkspaceId() workspaceId: string) {
    return this.reviewService.merge(id,dto.targetVulnerabilityId,user.id,workspaceId);
  }

  @Doc({ summary: 'Find approved duplicates of a proposal', response: { serialization: VulnerabilityDuplicatesResponseDto }, request: { getWorkspaceId: true } })
  @WorkspaceAccess('vulnerability.read')
  @Header('Cache-Control', 'private, no-store')
  @Get(':id/review/duplicates')
  duplicates(@Param('id', ParseUUIDPipe) id: string, @WorkspaceId() workspaceId: string) {
    return this.reviewService.duplicates(id,workspaceId);
  }

  @Doc({
    summary: 'Scan targets',
    description:
      'Initiates a vulnerability scan for one or more targets. Domain, CIDR and IP targets run the vulnerability_scan_basic workflow (nuclei); Git organization targets run the repository_scan workflow.',
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.write')
  @Post('scan')
  scan(@Body() scanDto: ScanDto, @WorkspaceId() workspaceId: string) {
    return this.vulnerabilitiesService.scan(scanDto.targetIds, workspaceId);
  }

  @Doc({
    summary: 'Get vulnerabilities',
    description:
      'Retrieves a comprehensive list of security vulnerabilities identified across targets and assets, including detailed information about risks and remediation recommendations.',
    response: {
      serialization: GetManyResponseDto(VulnerabilityLifecycleDto),
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.read')
  @Get()
  async getVulnerabilities(
    @Query() query: GetVulnerabilitiesQueryDto,
    @WorkspaceId() workspaceId: string,
    @Req() request?: RequestWithMetadata,
  ) {
    return this.vulnerabilitiesService.getVulnerabilities(query, workspaceId,
      request?.permissions?.some(permission => ['*', 'job.read', 'job.write'].includes(permission)) ?? false,
      { userId: request?.user?.id, canReadAgents: request?.permissions?.some(permission => ['*','agent.read','agent.write'].includes(permission)) ?? false });
  }

  @Doc({
    summary: 'Get vulnerabilities statistics',
    description:
      'Provides aggregated statistical analysis of security vulnerabilities categorized by severity levels, enabling risk assessment and prioritization of remediation efforts.',
    response: {
      serialization: GetVulnerabilitiesStatisticsResponseDto,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.read')
  @Get('statistics')
  async getVulnerabilitiesStatistics(
    @Query() query: GetVulnerabilitiesStatisticsQueryDto,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.vulnerabilitiesService.getVulnerabilitiesStatistics(
      query,
      workspaceId,
    );
  }

  @Doc({
    summary: 'Get vulnerability management settings',
    response: { serialization: VulnerabilitySettingsDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('vulnerability.read')
  @Header('Cache-Control', 'private, no-store')
  @Get('settings')
  getSettings(@WorkspaceId() workspaceId: string) {
    return this.lifecycleService.getSettings(workspaceId);
  }

  @Doc({
    summary: 'Update vulnerability management settings',
    response: { serialization: VulnerabilitySettingsDto },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.vulnerability.settings.updated, {
    changes: vulnerabilitySettingsChanges,
  })
  @WorkspaceAccess('workspace.config')
  @Put('settings')
  updateSettings(@WorkspaceId() workspaceId: string, @Body() dto: UpdateVulnerabilitySettingsDto) {
    return this.lifecycleService.updateSettings(workspaceId, dto);
  }

  @Doc({
    summary: 'Report findings fixed pending scan verification',
    response: { serialization: ClaimFixResponseDto },
    request: { getWorkspaceId: true },
  })
  @PublishEvent(EVENT_CATALOG.vulnerability.status.updated, {
    metadata: body => ({ action: 'claim_fix', count: new Set((body as ClaimFixDto)?.vulnerabilityIds ?? []).size }),
  })
  @WorkspaceAccess('vulnerability.write')
  @Post('claim-fix')
  @HttpCode(HttpStatus.OK)
  claimFix(@WorkspaceId() workspaceId: string, @UserContext() user: User, @Body() dto: ClaimFixDto) {
    return this.lifecycleService.claimFix(dto.vulnerabilityIds, workspaceId, user.id, dto.note);
  }

  @Doc({
    summary: 'Get vulnerability by id',
    description:
      'Retrieves detailed information about a specific security vulnerability identified within the system, including its attributes, associated assets, and remediation guidance.',
    response: {
      serialization: VulnerabilityLifecycleDetailDto,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.read')
  @Get(':id')
  getVulnerabilityById(
    @Param('id') id: string,
    @WorkspaceId() workspaceId: string,
    @Req() request?: RequestWithMetadata,
  ) {
    return this.vulnerabilitiesService.getVulnerability(id, workspaceId,
      request?.permissions?.some(permission => ['*', 'job.read', 'job.write'].includes(permission)) ?? false,
      { userId: request?.user?.id, canReadAgents: request?.permissions?.some(permission => ['*','agent.read','agent.write'].includes(permission)) ?? false });
  }

  @Doc({
    summary: 'Get vulnerability timeline',
    description: 'Returns up to 500 detection and status events, newest first.',
    response: { serialization: VulnerabilityTimelineResponseDto },
    request: { getWorkspaceId: true },
  })
  @WorkspaceAccess('vulnerability.read')
  @Get(':id/timeline')
  @Header('Cache-Control', 'private, no-store')
  getVulnerabilityTimeline(
    @Param('id', ParseUUIDPipe) id: string,
    @WorkspaceId() workspaceId: string,
    @Req() request: RequestWithMetadata,
  ) {
    const canReadJobs =
      request.permissions?.some(
        (permission) =>
          permission === '*' ||
          permission === 'job.read' ||
          permission === 'job.write',
      ) ?? false;
    return this.vulnerabilitiesService.getVulnerabilityTimeline(
      id,
      workspaceId,
      canReadJobs,
    );
  }

  @Doc({
    summary: 'Analyze a vulnerability',
    description:
      'Initiates an AI-powered analysis of a specific security vulnerability to provide detailed insights and recommendations.',
    response: {
      serialization: DefaultMessageResponseDto,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.write')
  @Post(':id/analyze')
  @HttpCode(HttpStatus.OK)
  async analyzeVulnerability(
    @Param('id') id: string,
    @WorkspaceId() workspaceId: string,
    @UserContext() user: User,
    @Body() dto: AnalyzeVulnerabilityDto,
  ) {
    return this.vulnerabilitiesService.analyzeVulnerability(
      id,
      workspaceId,
      user.id,
      dto.forceRerun ?? false,
    );
  }

  @Doc({
    summary: 'Delete vulnerability analysis result',
    description:
      'Removes the AI analysis result from a vulnerability and resets its status to not analyzed.',
    response: {
      serialization: DefaultMessageResponseDto,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @WorkspaceAccess('vulnerability.write')
  @Delete(':id/analyze')
  async deleteVulnerabilityAnalysis(
    @Param('id') id: string,
    @WorkspaceId() workspaceId: string,
  ) {
    return this.vulnerabilitiesService.deleteVulnerabilityAnalysis(
      id,
      workspaceId,
    );
  }

  @Doc({
    summary: 'Bulk dismiss vulnerabilities',
    description:
      'Dismisses multiple security vulnerabilities identified within the system, removing them from active tracking and analysis.',
    response: {
      serialization: VulnerabilityDismissal,
      isArray: true,
      httpStatus: HttpStatus.CREATED,
    },
    request: {
      getWorkspaceId: true,
    },
  })
  @PublishEvent(EVENT_CATALOG.vulnerability.status.updated, {
    // No before/after status is derivable decorator-only — the row carries the
    // bulk action and the affected count (plan §4 row 21: high-evidence event).
    metadata: (body) => {
      const ids = (body as { ids?: unknown })?.ids;
      return { action: 'dismiss', count: Array.isArray(ids) ? new Set(ids).size : 0 };
    },
  })
  @WorkspaceAccess('vulnerability.write')
  @Post('dismiss')
  bulkDismissVulnerabilities(
    @WorkspaceId() workspaceId: string,
    @UserContext() user: User,
    @Body() dto: BulkDismissVulnerabilitiesDto,
  ) {
    return this.vulnerabilitiesService.bulkDismissVulnerabilities(
      dto.ids,
      workspaceId,
      user,
      dto,
    );
  }

  @Doc({
    summary: 'Bulk reopen vulnerabilities',
    description:
      'Reopens multiple security vulnerabilities identified within the system, restoring them to active tracking and analysis.',
    request: {
      getWorkspaceId: true,
    },
  })
  @PublishEvent(EVENT_CATALOG.vulnerability.bulk_updated, {
    metadata: (body) => {
      const ids = (body as { ids?: string[] })?.ids;
      return { action: 'reopen', count: ids?.length ?? 0 };
    },
  })
  @WorkspaceAccess('vulnerability.write')
  @Post('reopen')
  bulkReopenVulnerabilities(
    @WorkspaceId() workspaceId: string,
    @UserContext() user: User,
    @Body() dto: BulkReopenVulnerabilitiesDto,
  ) {
    return this.vulnerabilitiesService.bulkReopenVulnerabilities(
      dto.ids,
      workspaceId,
      user,
    );
  }
}
