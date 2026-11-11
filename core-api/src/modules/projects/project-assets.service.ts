import { ProjectAssetSource } from '@/common/enums/enum';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { lockProjectScope } from './project-scope-sync';
import { excludeMatchedScopeAssets } from './project-scope-exclusions';

function normalizeAssetIds(assetIds: string[]): string[] {
  if (
    !Array.isArray(assetIds) ||
    assetIds.some((id) => typeof id !== 'string' || !isUUID(id.trim()))
  ) {
    throw new BadRequestException('assetIds must be an array of UUIDs');
  }
  return [...new Set(assetIds.map((id) => id.trim().toLowerCase()))];
}

/** Canonical membership writes; legacy group duplicate semantics stay separate. */
@Injectable()
export class ProjectAssetsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Hand-pick every requested asset and return only newly inserted members. */
  async add(
    projectId: string,
    workspaceId: string,
    assetIds: string[],
  ): Promise<string[]> {
    const ids = normalizeAssetIds(assetIds);
    return this.dataSource.transaction(async (manager) => {
      const id = await lockProjectScope(manager, projectId, workspaceId);
      if (ids.length === 0) return [];
      const owned = await manager.query<{ id: string }[]>(
        `SELECT a.id FROM assets a JOIN targets t ON t.id=a."targetId"
         WHERE t."workspaceId"=$1 AND a.id=ANY($2::uuid[])`,
        [workspaceId, ids],
      );
      const found = new Set(owned.map((asset) => asset.id));
      const missing = ids.filter((assetId) => !found.has(assetId));
      if (missing.length)
        throw new NotFoundException(
          `One or more assets with IDs "${missing.join(', ')}" not found`,
        );
      const rows = await manager.query<
        { assetId: string; inserted: boolean }[]
      >(
        `INSERT INTO project_assets ("projectId","assetId",source)
         SELECT $1, id, '${ProjectAssetSource.MANUAL}' FROM unnest($2::uuid[]) AS id
         ON CONFLICT ("projectId","assetId") DO UPDATE
            SET source='${ProjectAssetSource.MANUAL}', "scopeRuleId"=NULL, "updatedAt"=now()
          WHERE project_assets.source <> '${ProjectAssetSource.MANUAL}'
         RETURNING "assetId", (xmax=0) AS inserted`,
        [id, ids],
      );
      return rows.filter((row) => row.inserted).map((row) => row.assetId);
    });
  }

  /** Remove owned memberships and exclude still-matched assets atomically. */
  async remove(
    projectId: string,
    workspaceId: string,
    assetIds: string[],
  ): Promise<number> {
    const ids = normalizeAssetIds(assetIds);
    return this.dataSource.transaction(async (manager) => {
      const id = await lockProjectScope(manager, projectId, workspaceId);
      if (!ids.length) return 0;
      await excludeMatchedScopeAssets(manager, id, workspaceId, ids);
      const removed = await manager.query<unknown[]>(
        `DELETE FROM project_assets pa USING assets a, targets t
         WHERE pa."projectId"=$1 AND pa."assetId"=ANY($3::uuid[])
           AND a.id=pa."assetId" AND t.id=a."targetId" AND t."workspaceId"=$2
         RETURNING pa.id`,
        [id, workspaceId, ids],
      );
      // PostgreSQL DELETE RETURNING uses [rows, count] through TypeORM.
      return Array.isArray(removed[0]) ? removed[0].length : removed.length;
    });
  }
}
