import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AssetGroupService } from '../asset-group/asset-group.service';
import { GetAllAssetGroupsQueryDto } from '../asset-group/dto/get-all-asset-groups-dto.dto';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { ProjectMetadataReadService } from './project-metadata-read.service';

describe('ProjectMetadataReadService', () => {
  const groups = {
    getManyAssetGroups: jest.fn(),
    getAssetGroupById: jest.fn(),
  };
  const dataSource = { query: jest.fn() };
  const service = new ProjectMetadataReadService(
    groups as unknown as AssetGroupService,
    dataSource as unknown as DataSource,
  );
  const query = new GetAllAssetGroupsQueryDto();
  beforeEach(() => jest.resetAllMocks());

  it('batches metadata once with bound workspace and ids, retaining base fields', async () => {
    const a = Object.assign(new AssetGroup(), {
      id: 'a',
      name: 'A',
      totalAssets: 0,
      description: 'stale',
      archivedAt: new Date(),
      assetGroupWorkflows: [],
      customField: 'retained',
    });
    groups.getManyAssetGroups.mockResolvedValue({
      data: [a, { id: 'b', name: 'B' }],
      total: 2,
      page: 1,
      limit: 10,
    });
    dataSource.query.mockResolvedValue([
      { id: 'a', description: 'Saved', autoAddAssets: false },
      { id: 'b', description: null, autoAddAssets: true },
    ]);
    const result = await service.getMany(query, 'workspace');
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"workspaceId" = $1 AND id = ANY($2::uuid[])'),
      ['workspace', ['a', 'b']],
    );
    expect(result).toMatchObject({
      total: 2,
      page: 1,
      limit: 10,
      data: [
        {
          id: 'a',
          description: 'Saved',
          autoAddAssets: false,
          totalAssets: 0,
          assetGroupWorkflows: [],
          customField: 'retained',
        },
        { id: 'b', description: null, autoAddAssets: true },
      ],
    });
    expect(JSON.parse(JSON.stringify(result.data[0]))).toHaveProperty(
      'description',
      'Saved',
    );
    expect(result.data[0]).not.toHaveProperty('archivedAt');
  });

  it('does not query metadata for an empty list', async () => {
    groups.getManyAssetGroups.mockResolvedValue({ data: [], total: 0 });
    expect(await service.getMany(query, 'workspace')).toEqual({
      data: [],
      total: 0,
    });
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('omits concurrently deleted items without failing the whole page', async () => {
    groups.getManyAssetGroups.mockResolvedValue({
      data: [{ id: 'a' }, { id: 'b' }],
      total: 2,
    });
    dataSource.query.mockResolvedValue([
      { id: 'b', description: null, autoAddAssets: true },
    ]);
    expect(await service.getMany(query, 'workspace')).toMatchObject({
      total: 2,
      data: [{ id: 'b' }],
    });
  });

  it('fails closed when detail metadata disappears', async () => {
    groups.getAssetGroupById.mockResolvedValue({ id: 'a' });
    dataSource.query.mockResolvedValue([]);
    await expect(service.getById('a', 'workspace')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('does not load metadata when the base scoped lookup fails', async () => {
    groups.getAssetGroupById.mockRejectedValue(new NotFoundException());
    await expect(service.getById('foreign', 'workspace')).rejects.toThrow(
      NotFoundException,
    );
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
