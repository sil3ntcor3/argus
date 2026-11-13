import { BullMQName } from '@/common/enums/enum';
import { BullModule } from '@nestjs/bullmq';
import { Global, Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentsModule } from '../agents/agents.module';
import { Asset } from '../assets/entities/assets.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Target } from '../targets/entities/target.entity';
import { VulnerabilityDismissal } from './entities/vulnerability-dismissal.entity';
import { Vulnerability } from './entities/vulnerability.entity';
import { FindingRiskExpiryService } from './finding-risk-expiry.service';
import { VulnerabilityAnalysisProcessor } from './processors/vulnerability-analysis.processor';
import { VulnerabilitiesController } from './vulnerabilities.controller';
import { VulnerabilitiesService } from './vulnerabilities.service';
import { VulnerabilityLifecycleService } from './vulnerability-lifecycle.service';
import { VulnerabilityReviewService } from './vulnerability-review.service';
import { VulnerabilityProposalService } from './vulnerability-proposal.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Vulnerability,
      Asset,
      VulnerabilityDismissal,
      Target,
    ]),
    forwardRef(() => AgentsModule),
    NotificationsModule,
    BullModule.registerQueue({
      name: BullMQName.VULNERABILITY_ANALYSIS,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
      },
    }),
  ],
  controllers: [VulnerabilitiesController],
  providers: [
    VulnerabilitiesService,
    VulnerabilityAnalysisProcessor,
    FindingRiskExpiryService,
    VulnerabilityLifecycleService,
    VulnerabilityReviewService,
    VulnerabilityProposalService,
  ],
  exports: [VulnerabilitiesService, VulnerabilityProposalService],
})
export class VulnerabilitiesModule {}
