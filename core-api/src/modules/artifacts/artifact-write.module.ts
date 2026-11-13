import { Module } from '@nestjs/common';
import { ArtifactBufferService } from './artifact-buffer.service';
import { ArtifactQuotaModule } from './artifact-quota.module';
import { ArtifactUploadCompletionService } from './artifact-upload-completion.service';
import { ArtifactUploadReservationService } from './artifact-upload-reservation.service';

@Module({
  imports: [ArtifactQuotaModule],
  providers: [ArtifactUploadReservationService, ArtifactUploadCompletionService, ArtifactBufferService],
  exports: [ArtifactBufferService, ArtifactUploadReservationService, ArtifactUploadCompletionService],
})
export class ArtifactWriteModule {}
