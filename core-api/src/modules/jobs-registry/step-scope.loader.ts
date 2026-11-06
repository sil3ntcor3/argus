import { DataKind, type TargetType } from '@/common/enums/enum';
import type { DataSource } from 'typeorm';
import { AssetService } from '../assets/entities/asset-services.entity';
import { Asset } from '../assets/entities/assets.entity';
import {
  kindsToLoad,
  type ScopeData,
  type ScopeService,
  type ScopeWebService,
} from './step-inputs';

/** Which assets a step runs on. Empty lists mean "no filter". */
export interface StepScopeFilter {
  targetIds?: string[];
  assetIds?: string[];
  /** Narrows services to these, e.g. to re-run one service. */
  assetServiceIds?: string[];
  workspaceId?: string;
  /** Target types the tool's category may scan. */
  targetTypes: TargetType[];
}

/** The scope of a step, plus the entities the new jobs point at. */
export interface LoadedStepScope {
  scope: ScopeData;
  assets: Map<string, Asset>;
  services: Map<string, AssetService>;
}

/** Loads enabled scoped assets and only the input kinds a step needs. */
export class StepScopeLoader {
  constructor(private readonly dataSource: DataSource) {}

  async load(
    inputs: readonly DataKind[],
    filter: StepScopeFilter,
  ): Promise<LoadedStepScope> {
    if (inputs.includes(DataKind.URL)) {
      throw new Error('URL scope loading is not yet supported');
    }
    const assets = await this.loadAssets(filter);
    const assetIds = assets.map((asset) => asset.id);
    const need = kindsToLoad(inputs);
    const services = new Map<string, AssetService>();
    const scope: ScopeData = {
      assets: assets.map((asset) => ({
        id: asset.id,
        value: asset.value,
        isPrimary: asset.isPrimary ?? false,
        targetType: asset.target.type,
      })),
    };

    if (assetIds.length > 0 && (need.services || need.web)) {
      const rows = await this.loadServices(assetIds, filter.assetServiceIds);
      rows.forEach((row) => services.set(row.id, row));
      if (need.services) {
        scope.services = groupByAsset(rows.map(toScopeService));
      }
      if (need.web) {
        const schemes = await this.loadWebSchemes(rows.map((row) => row.id));
        scope.web = groupByAsset(
          rows
            .filter((row) => schemes.has(row.id))
            .map((row): ScopeWebService => ({
              ...toScopeService(row),
              scheme: schemes.get(row.id)!,
            })),
        );
      }
    }

    return {
      scope,
      assets: new Map(assets.map((asset) => [asset.id, asset])),
      services,
    };
  }

  private async loadAssets(filter: StepScopeFilter): Promise<Asset[]> {
    if (filter.targetTypes.length === 0) return [];
    const query = this.dataSource
      .getRepository(Asset)
      .createQueryBuilder('assets')
      .innerJoinAndSelect('assets.target', 'target')
      .where('assets.isEnabled = true')
      .andWhere('target.type IN (:...targetTypes)', {
        targetTypes: filter.targetTypes,
      });
    if (filter.targetIds?.length) {
      query.andWhere('assets.targetId IN (:...targetIds)', {
        targetIds: filter.targetIds,
      });
    }
    if (filter.assetIds?.length) {
      query.andWhere('assets.id IN (:...assetIds)', {
        assetIds: filter.assetIds,
      });
    }
    if (filter.workspaceId) {
      query.andWhere('target.workspaceId = :workspaceId', {
        workspaceId: filter.workspaceId,
      });
    }
    return query.getMany();
  }

  private async loadServices(
    assetIds: string[],
    assetServiceIds: string[] | undefined,
  ): Promise<AssetService[]> {
    const query = this.dataSource
      .getRepository(AssetService)
      .createQueryBuilder('service')
      .where('service.assetId IN (:...assetIds)', { assetIds });
    if (assetServiceIds?.length) {
      query.andWhere('service.id IN (:...assetServiceIds)', {
        assetServiceIds,
      });
    }
    return query.getMany();
  }

  /** Uses each service's latest successful HTTP response scheme. */
  private async loadWebSchemes(
    serviceIds: string[],
  ): Promise<Map<string, 'http' | 'https'>> {
    if (serviceIds.length === 0) return new Map();
    const rows: Array<{ id: string; scheme: string | null }> =
      await this.dataSource.query(
        `SELECT DISTINCT ON (hr."assetServiceId") hr."assetServiceId" AS id, hr.scheme
           FROM http_responses hr
          WHERE hr."assetServiceId"::text = ANY($1::text[])
            AND hr.failed = false
          ORDER BY hr."assetServiceId", hr."createdAt" DESC`,
        [serviceIds],
      );
    return new Map(
      rows.map((row) => [
        row.id,
        row.scheme?.toLowerCase() === 'http' ? 'http' : 'https',
      ]),
    );
  }
}

function toScopeService(row: AssetService): ScopeService {
  return {
    id: row.id,
    assetId: row.assetId,
    value: row.value,
    port: row.port,
  };
}

function groupByAsset<T extends { assetId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byAsset = new Map<string, T[]>();
  for (const row of rows) {
    byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row]);
  }
  return byAsset;
}
