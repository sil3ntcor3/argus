import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template } from './entities/templates.entity';
import { ArtifactWriteModule } from '../artifacts/artifact-write.module';
import { ArtifactQuotaModule } from '../artifacts/artifact-quota.module';
import { TemplateArtifactService } from './template-artifact.service';

@Module({
  imports: [TypeOrmModule.forFeature([Template]), WorkspacesModule, ArtifactWriteModule, ArtifactQuotaModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplateArtifactService],
  exports: [TemplatesService, TemplateArtifactService],
})
export class TemplatesModule {}
