import { DataKind, TargetType } from '@/common/enums/enum';
import type { DataSource } from 'typeorm';
import { StepScopeLoader } from './step-scope.loader';

/** A chainable query builder whose getMany resolves `rows`. */
const queryBuilder = (rows: unknown[]) => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['innerJoinAndSelect', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
};

describe('StepScopeLoader', () => {
  const asset = {
    id: 'a-app',
    value: 'app.example.com',
    isPrimary: false,
    target: { type: TargetType.DOMAIN },
  };
  const services = [22, 8443].map((port) => ({
    id: `s-${port}`,
    assetId: asset.id,
    value: `${asset.value}:${port}`,
    port,
  }));

  let assetsQB: ReturnType<typeof queryBuilder>;
  let servicesQB: ReturnType<typeof queryBuilder>;
  let query: jest.Mock;
  let loader: StepScopeLoader;

  beforeEach(() => {
    assetsQB = queryBuilder([asset]);
    servicesQB = queryBuilder(services);
    query = jest.fn().mockResolvedValue([]);
    const dataSource = {
      getRepository: jest.fn((entity: { name: string }) => ({
        createQueryBuilder: () =>
          entity.name === 'Asset' ? assetsQB : servicesQB,
      })),
      query,
    } as unknown as DataSource;
    loader = new StepScopeLoader(dataSource);
  });

  it('loads the enabled assets of the scope, of the target types the tool scans', async () => {
    const { scope, assets } = await loader.load([DataKind.HOST], {
      assetIds: ['a-app'],
      workspaceId: 'ws-1',
      targetTypes: [TargetType.DOMAIN],
    });

    expect(assetsQB.where).toHaveBeenCalledWith('assets.isEnabled = true');
    expect(assetsQB.andWhere).toHaveBeenCalledWith(
      'target.type IN (:...targetTypes)',
      {
        targetTypes: [TargetType.DOMAIN],
      },
    );
    expect(assetsQB.andWhere).toHaveBeenCalledWith(
      'assets.id IN (:...assetIds)',
      {
        assetIds: ['a-app'],
      },
    );
    expect(assetsQB.andWhere).toHaveBeenCalledWith(
      'target.workspaceId = :workspaceId',
      {
        workspaceId: 'ws-1',
      },
    );
    expect(assetsQB.andWhere).not.toHaveBeenCalledWith(
      'assets.targetId IN (:...targetIds)',
      expect.anything(),
    );
    expect(scope.assets).toEqual([
      {
        id: 'a-app',
        value: 'app.example.com',
        isPrimary: false,
        targetType: TargetType.DOMAIN,
      },
    ]);
    expect(assets.get('a-app')).toBe(asset);
    // Hosts need no service, web or URL rows.
    expect(servicesQB.getMany).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('loads every open port for a step that takes services', async () => {
    const { scope } = await loader.load([DataKind.SERVICE], {
      targetTypes: [TargetType.DOMAIN],
    });

    expect(servicesQB.where).toHaveBeenCalledWith(
      'service.assetId IN (:...assetIds)',
      {
        assetIds: ['a-app'],
      },
    );
    expect(scope.services?.get('a-app')?.map((s) => s.port)).toEqual([
      22, 8443,
    ]);
    expect(scope.web).toBeUndefined();
  });

  it('keeps as web only the services with a good HTTP answer, with its scheme', async () => {
    query.mockResolvedValueOnce([{ id: 's-8443', scheme: 'https' }]);

    const { scope, services: loaded } = await loader.load(
      [DataKind.WEB, DataKind.HOST],
      {
        targetTypes: [TargetType.DOMAIN],
      },
    );

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM http_responses hr');
    expect(sql).toContain('hr.failed = false');
    expect(sql).toContain('ORDER BY hr."assetServiceId", hr."createdAt" DESC');
    expect(params).toEqual([['s-22', 's-8443']]);
    expect(scope.web?.get('a-app')).toEqual([
      {
        id: 's-8443',
        assetId: 'a-app',
        value: 'app.example.com:8443',
        port: 8443,
        scheme: 'https',
      },
    ]);
    expect(loaded.get('s-8443')).toBe(services[1]);
  });

  it('narrows services to the ones asked for', async () => {
    await loader.load([DataKind.SERVICE], {
      assetServiceIds: ['s-8443'],
      targetTypes: [TargetType.DOMAIN],
    });

    expect(servicesQB.andWhere).toHaveBeenCalledWith(
      'service.id IN (:...assetServiceIds)',
      {
        assetServiceIds: ['s-8443'],
      },
    );
  });

  it('loads nothing more when no asset is in scope', async () => {
    assetsQB.getMany.mockResolvedValue([]);

    const { scope } = await loader.load([DataKind.WEB], {
      targetTypes: [TargetType.DOMAIN],
    });

    expect(scope.assets).toEqual([]);
    expect(servicesQB.getMany).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('loads nothing when no target type is allowed', async () => {
    const { scope } = await loader.load([DataKind.HOST], { targetTypes: [] });
    expect(scope.assets).toEqual([]);
    expect(assetsQB.getMany).not.toHaveBeenCalled();
  });
  it('loads eligible URLs and their owning service entities', async () => {
    const url = 'https://app.example.com:8443/login';
    query.mockResolvedValueOnce([
      {
        url,
        assetId: asset.id,
        serviceId: 's-8443',
        cursorCreatedAt: '2026-11-06 00:00:00.123456',
        cursorId: 'cursor',
      },
    ]);
    const loaded = await loader.load([DataKind.URL], {
      targetTypes: [TargetType.DOMAIN],
    });
    expect(loaded.scope.urls?.get(asset.id)).toEqual([
      { url, assetId: asset.id, serviceId: 's-8443' },
    ]);
    expect(loaded.services.get('s-8443')).toBe(services[1]);
    expect(servicesQB.where).toHaveBeenCalledWith('service.id IN (:...ids)', {
      ids: ['s-8443'],
    });
  });
});
