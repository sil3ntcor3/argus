import { Injectable } from '@nestjs/common';
import { ProjectScopeDiscoveryService } from '@/modules/projects/project-scope-discovery.service';
import {
  AuditActorType,
  AuditOutcome,
  EventBusGroup,
  ProjectChange,
} from '@/common/enums/enum';
import { isUUID } from 'class-validator';
import { EVENT_CATALOG, type EventName } from '../../contracts/event-catalog';
import type { ConsumedEvent } from '../../contracts/event-envelope';
import {
  readPayload,
  type ProjectAssetsAddedPayload,
} from '../../contracts/event-payloads';
import { EventBridgeService } from '../../publishing/event-bridge.service';
import type { EventSink } from '../../consuming/event-sink';
import { SUBSCRIPTIONS } from '../../routing/subscriptions';

@Injectable()
export class ProjectsSink implements EventSink {
  readonly group = EventBusGroup.Projects;
  readonly domains = SUBSCRIPTIONS[EventBusGroup.Projects];
  constructor(
    private readonly scope: ProjectScopeDiscoveryService,
    private readonly bridge: EventBridgeService,
  ) {}
  accepts(name: EventName): boolean {
    return name === 'asset.discovered';
  }
  async handle(name: EventName, event: ConsumedEvent): Promise<void> {
    if (name !== 'asset.discovered') return;
    const payload = readPayload('asset.discovered', event);
    const assetIds = Array.isArray(payload.assetIds)
      ? [
          ...new Set(
            payload.assetIds
              .filter(
                (id): id is string => typeof id === 'string' && isUUID(id),
              )
              .map((id) => id.toLowerCase()),
          ),
        ]
      : [];
    if (assetIds.length === 0) return;
    const jobHistoryId =
      typeof payload.jobHistoryId === 'string' && isUUID(payload.jobHistoryId)
        ? payload.jobHistoryId.toLowerCase()
        : undefined;
    const added = await this.scope.addDiscoveredAssets(
      event.workspaceId,
      assetIds,
    );
    for (const [projectId, ids] of added) {
      if (ids.length === 0) continue;
      const resource = {
        workspaceId: event.workspaceId,
        outcome: AuditOutcome.Success,
        resourceType: 'project',
        resourceId: projectId,
      };
      const subject = {
        subject: `workspace:${event.workspaceId}/project:${projectId}`,
      };
      await this.bridge.publishSafely(
        EVENT_CATALOG.project.assets.added,
        {
          ...resource,
          payload: {
            projectId,
            assetIds: ids,
            ...(jobHistoryId ? { jobHistoryId } : {}),
          } satisfies ProjectAssetsAddedPayload,
        },
        subject,
      );
      await this.bridge.publishSafely(
        EVENT_CATALOG.project.updated,
        {
          ...resource,
          actor: { type: AuditActorType.System },
          metadata: {
            change: ProjectChange.ASSETS_DISCOVERED,
            added: ids.length,
          },
        },
        subject,
      );
    }
  }
}
