import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { ArtifactQuotaModule } from '@/modules/artifacts/artifact-quota.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminWorkspacesController } from './admin-workspaces.controller';
import { AdminWorkspacesService } from './admin-workspaces.service';
import { SystemConfigsModule } from '../system-configs/system-configs.module';

/**
 * Admin read access to every workspace, served under /admin/workspaces.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Workspace]), ArtifactQuotaModule, SystemConfigsModule],
  controllers: [AdminWorkspacesController],
  providers: [AdminWorkspacesService],
})
export class AdminWorkspacesModule {}
