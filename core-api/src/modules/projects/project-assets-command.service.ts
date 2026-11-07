import { AuditOutcome } from '@/common/enums/enum';
import { Injectable } from '@nestjs/common';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import type { ProjectAssetsAddedPayload } from '../event-bridge/contracts/event-payloads';
import { EventBridgeService } from '../event-bridge/publishing/event-bridge.service';
import { ProjectAssetsService } from './project-assets.service';
import type { ProjectAssetsChangedDto } from './dto/project-assets-command.dto';

/** Request commands report only memberships committed by the underlying writer. */
@Injectable()
export class ProjectAssetsCommandService {
  constructor(
    private readonly assets: ProjectAssetsService,
    private readonly bridge: EventBridgeService,
  ) {}

  async add(
    projectId: string,
    workspaceId: string,
    assetIds: string[],
  ): Promise<ProjectAssetsChangedDto> {
    const added = await this.assets.add(projectId, workspaceId, assetIds);
    if (added.length) {
      const id = projectId.toLowerCase();
      await this.bridge.publishSafely(
        EVENT_CATALOG.project.assets.added,
        {
          workspaceId,
          outcome: AuditOutcome.Success,
          resourceType: 'project',
          resourceId: id,
          payload: {
            projectId: id,
            assetIds: added,
          } satisfies ProjectAssetsAddedPayload,
        },
        { subject: `workspace:${workspaceId}/project:${id}` },
      );
    }
    return {
      message: `${added.length} assets added to the project`,
      count: added.length,
    };
  }
}
