import { Module } from '@nestjs/common';
import { ArtifactQuotaService } from './artifact-quota.service';

@Module({
  providers: [ArtifactQuotaService],
  exports: [ArtifactQuotaService],
})
export class ArtifactQuotaModule {}
