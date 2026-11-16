import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { AuditOutcome } from '@/common/enums/enum';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';
import type { ProjectAssetsAddedPayload } from '../event-bridge/contracts/event-payloads';
import { EventBridgeService } from '../event-bridge/publishing/event-bridge.service';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import {
  ProjectScopeNormalizer,
  type ScopeRuleInput,
} from './project-scope-normalizer.service';
import {
  lockProjectScope,
  syncProjectScope,
  type ScopeSyncResult,
} from './project-scope-sync';

/** Atomic rule replacement for canonical project scope writes. */
@Injectable()
export class ProjectScopeWriteService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly normalizer: ProjectScopeNormalizer,
    private readonly bridge: EventBridgeService,
  ) {}

  async replaceRules(
    projectId: string,
    workspaceId: string,
    input: ScopeRuleInput[],
    autoAddAssets?: boolean,
    abortSignal?: AbortSignal,
    change?: { add?: ScopeRuleInput[]; removeRuleIds?: string[] },
  ): Promise<ScopeSyncResult> {
    if (
      !Array.isArray(input) ||
      input.length > 100 ||
      input.some(
        (rule) =>
          !rule || typeof rule.value !== 'string' || rule.value.length > 255,
      )
    ) {
      throw new BadRequestException(
        'Expected at most 100 scope rules with string values up to 255 characters',
      );
    }
    if (autoAddAssets !== undefined && typeof autoAddAssets !== 'boolean') {
      throw new BadRequestException('autoAddAssets must be a boolean');
    }
    let canonicalId = projectId;
    const result = await this.dataSource.transaction(async (manager) => {
      const id = await lockProjectScope(manager, projectId, workspaceId);
      abortSignal?.throwIfAborted();
      canonicalId = id;
      if (change) {
        const current = await manager.find(ProjectScopeRule, { where: { projectId: id }, order: { createdAt: 'ASC', id: 'ASC' } });
        const removed = new Set(change.removeRuleIds ?? []);
        input = [...current.filter(rule => !removed.has(rule.id)).map(({ mode, type, value }) => ({ mode, type, value })), ...(change.add ?? [])];
        if (input.length > 100) throw new BadRequestException('Expected at most 100 scope rules');
      }
      const rules = await this.normalizer.normalizeRules(
        workspaceId,
        input,
        manager,
      );
      await manager.delete(ProjectScopeRule, { projectId: id });
      if (rules.length) {
        await manager.save(
          ProjectScopeRule,
          rules.map((rule) => ({ ...rule, projectId: id })),
        );
      }
      if (autoAddAssets !== undefined) {
        await manager.update(AssetGroup, { id }, { autoAddAssets });
      }
      const synced = await syncProjectScope(manager, id, workspaceId);
      abortSignal?.throwIfAborted();
      return synced;
    });
    if (result.added.length) {
      await this.bridge.publishSafely(
        EVENT_CATALOG.project.assets.added,
        {
          workspaceId,
          outcome: AuditOutcome.Success,
          resourceType: 'project',
          resourceId: canonicalId,
          payload: {
            projectId: canonicalId,
            assetIds: result.added,
          } satisfies ProjectAssetsAddedPayload,
        },
        { subject: `workspace:${workspaceId}/project:${canonicalId}` },
      );
    }
    return result;
  }

  /** AI add/remove operations merge under the same lock as replacement and sync. */
  patchRules(projectId: string, workspaceId: string, change: { add?: ScopeRuleInput[]; removeRuleIds?: string[]; autoAddAssets?: boolean }, abortSignal?: AbortSignal) {
    return this.replaceRules(projectId, workspaceId, [], change.autoAddAssets, abortSignal, change);
  }
}
