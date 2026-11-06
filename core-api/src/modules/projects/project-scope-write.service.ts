import { AssetGroup } from '@/modules/asset-group/entities/asset-groups.entity';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

/** Internal replacement preparation; public writes follow separately. */
@Injectable()
export class ProjectScopeWriteService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly normalizer: ProjectScopeNormalizer,
  ) {}

  async replaceRules(
    projectId: string,
    workspaceId: string,
    input: ScopeRuleInput[],
    autoAddAssets?: boolean,
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
    return this.dataSource.transaction(async (manager) => {
      const id = await lockProjectScope(manager, projectId, workspaceId);
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
      return syncProjectScope(manager, id, workspaceId);
    });
  }
}
