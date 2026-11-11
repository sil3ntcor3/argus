import { Module } from '@nestjs/common';
import { ProjectScopeDiscoveryService } from './project-scope-discovery.service';

/** Discovery depends only on the global DataSource, avoiding a bridge/CRUD cycle. */
@Module({
  providers: [ProjectScopeDiscoveryService],
  exports: [ProjectScopeDiscoveryService],
})
export class ProjectScopeModule {}
