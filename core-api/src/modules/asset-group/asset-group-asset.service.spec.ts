import {
  GetManyBaseQueryParams,
  SortOrder,
} from '@/common/dtos/get-many-base.dto';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
import { Asset } from '../assets/entities/assets.entity';
import { AssetGroupAssetService } from './asset-group-asset.service';
import type { AssetGroupAsset } from './entities/asset-groups-assets.entity';
import type { AssetGroup } from './entities/asset-groups.entity';

describe('AssetGroupAssetService listing compatibility', () => {
  const methods = [
    'getAssetsByAssetGroupsId',
    'getAssetsNotInAssetGroup',
  ] as const;
  const groups = { findOne: jest.fn() };
  const assets = { createQueryBuilder: jest.fn() };
  let service: AssetGroupAssetService;
  let builder: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.clearAllMocks();
    builder = Object.fromEntries(
      [
        'innerJoin',
        'leftJoin',
        'where',
        'andWhere',
        'orderBy',
        'skip',
        'take',
      ].map((method) => [method, jest.fn().mockReturnThis()]),
    );
    builder.getManyAndCount = jest
      .fn()
      .mockResolvedValue([[{ id: 'asset-1' }], 1]);
    groups.findOne.mockResolvedValue({ id: 'group-1' });
    assets.createQueryBuilder.mockReturnValue(builder);
    service = new AssetGroupAssetService(
      groups as unknown as Repository<AssetGroup>,
      {} as Repository<AssetGroupAsset>,
      assets as unknown as Repository<Asset>,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(methods)(
    '%s preserves tenant checks, search, ordering and pagination',
    async (method) => {
      const query = Object.assign(new GetManyBaseQueryParams(), {
        page: 2,
        limit: 10,
        sortBy: 'value',
        sortOrder: SortOrder.ASC,
        search: 'alpha',
      });
      const result = await service[method]('group-1', query, 'workspace-1');
      expect(groups.findOne).toHaveBeenCalledWith({
        where: { id: 'group-1', workspace: { id: 'workspace-1' } },
      });
      expect(builder.andWhere).toHaveBeenCalledWith(
        'asset.value ILIKE :search',
        { search: '%alpha%' },
      );
      expect(builder.orderBy).toHaveBeenCalledWith(
        'asset.value',
        SortOrder.ASC,
      );
      expect(builder.skip).toHaveBeenCalledWith(10);
      expect(builder.take).toHaveBeenCalledWith(10);
      expect(result).toMatchObject({
        data: [{ id: 'asset-1' }],
        total: 1,
        page: 2,
        limit: 10,
      });
    },
  );

  it.each(methods)(
    '%s rejects an unavailable group before listing assets',
    async (method) => {
      groups.findOne.mockResolvedValue(null);
      await expect(
        service[method]('group-1', new GetManyBaseQueryParams(), 'workspace-1'),
      ).rejects.toThrow(NotFoundException);
      expect(assets.createQueryBuilder).not.toHaveBeenCalled();
    },
  );
});

describe('AssetGroupAssetService concurrent duplicate persistence', () => {
  const groupId = randomUUID(),
    assetId = randomUUID(),
    workspaceId = randomUUID();
  const manager = {
    queryRunner: { isTransactionActive: true },
    query: jest.fn(),
    getRepository: jest.fn(),
  };
  const transaction = jest.fn(
    async (work: (scoped: unknown) => Promise<unknown>) => work(manager),
  );
  const groups = { findOne: jest.fn(), manager: { transaction } },
    assets = { find: jest.fn() };
  const links = {
    find: jest.fn(),
    create: jest.fn((data: object) => data),
    save: jest.fn(),
  };
  let service: AssetGroupAssetService;
  beforeEach(() => {
    jest.clearAllMocks();
    groups.findOne.mockResolvedValue({ id: groupId });
    manager.query.mockResolvedValue([{ id: groupId }]);
    manager.getRepository.mockImplementation((entity: unknown) =>
      entity === Asset ? assets : links,
    );
    assets.find.mockResolvedValue([{ id: assetId }]);
    links.find.mockResolvedValue([]);
    links.save.mockResolvedValue([]);
    service = new AssetGroupAssetService(
      groups as unknown as Repository<AssetGroup>,
      links as unknown as Repository<AssetGroupAsset>,
      assets as unknown as Repository<Asset>,
    );
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses transaction-scoped repositories after locking the owned project', async () => {
    await expect(
      service.addManyAssets(groupId, [assetId], workspaceId),
    ).resolves.toEqual({
      message: `1 assets successfully added to asset group "${groupId}"`,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      [groupId, workspaceId],
    );
    expect(groups.findOne).not.toHaveBeenCalled();
    expect(links.save).toHaveBeenCalledWith([
      { assetGroup: { id: groupId }, asset: { id: assetId } },
    ]);
  });

  it('preserves the legacy missing-project response and never queries assets', async () => {
    manager.query.mockResolvedValue([]);
    await expect(
      service.addManyAssets(groupId, [assetId], workspaceId),
    ).rejects.toThrow(`Asset group with ID "${groupId}" not found`);
    expect(assets.find).not.toHaveBeenCalled();
    expect(links.save).not.toHaveBeenCalled();
  });

  it('propagates lock failures without changing membership', async () => {
    const failure = new Error('lock failed');
    manager.query.mockRejectedValue(failure);
    await expect(
      service.addManyAssets(groupId, [assetId], workspaceId),
    ).rejects.toBe(failure);
    expect(links.save).not.toHaveBeenCalled();
  });

  it('rejects missing assets and existing memberships before saving', async () => {
    assets.find.mockResolvedValue([]);
    await expect(
      service.addManyAssets(groupId, [assetId], workspaceId),
    ).rejects.toBeInstanceOf(NotFoundException);
    assets.find.mockResolvedValue([{ id: assetId }]);
    links.find.mockResolvedValue([{ asset: { id: assetId } }]);
    await expect(
      service.addManyAssets(groupId, [assetId], workspaceId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(links.save).not.toHaveBeenCalled();
  });

  it.each([
    ['23505', 'UQ_pa_projectId_assetId', true],
    ['23505', 'another_unique_index', false],
    ['23503', 'a_foreign_key', false],
  ])(
    'handles save error %s on %s without masking unrelated failures',
    async (code, constraint, duplicate) => {
      const error = new QueryFailedError(
        'INSERT project_assets',
        [],
        Object.assign(new Error('database save failure'), { code, constraint }),
      );
      links.save.mockRejectedValue(error);
      const result = service.addManyAssets(groupId, [assetId], workspaceId);
      if (duplicate)
        await expect(result).rejects.toBeInstanceOf(BadRequestException);
      else await expect(result).rejects.toBe(error);
    },
  );
});
