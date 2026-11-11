import { ProjectScopeDiscoveryService } from './project-scope-discovery.service';

describe('ProjectScopeDiscoveryService', () => {
  const workspace = 'workspace',
    project = 'project';
  const rule = {
    id: 'rule',
    mode: 'include',
    type: 'hostname',
    value: '*.argus.test',
  };
  const setup = () => {
    const manager = { query: jest.fn(), find: jest.fn() };
    const source = {
      transaction: jest.fn((run: (value: typeof manager) => unknown) =>
        run(manager),
      ),
    };
    return {
      manager,
      source,
      service: new ProjectScopeDiscoveryService(source as never),
    };
  };
  it('does no database work for an empty discovery batch', async () => {
    const { service, source } = setup();
    expect(await service.addDiscoveredAssets(workspace, [])).toEqual(new Map());
    expect(source.transaction).not.toHaveBeenCalled();
  });
  it('uses one transaction, bounded asset bindings and only newly inserted IDs', async () => {
    const { service, manager, source } = setup();
    manager.query
      .mockResolvedValueOnce([{ id: project }])
      .mockResolvedValueOnce([{ assetId: 'new' }]);
    manager.find.mockResolvedValue([rule]);
    expect(
      await service.addDiscoveredAssets(workspace, ['new', 'new', 'old']),
    ).toEqual(new Map([[project, ['new']]]));
    expect(source.transaction).toHaveBeenCalledTimes(1);
    expect(manager.query.mock.calls[0]).toEqual([
      expect.stringContaining('ORDER BY p.id FOR UPDATE OF p'),
      [workspace],
    ]);
    expect(manager.query.mock.calls[1][1]).toEqual([
      project,
      workspace,
      ['new', 'old'],
      '%.argus.test',
      'rule',
    ]);
    expect(manager.find).toHaveBeenCalledWith(expect.any(Function), {
      where: { projectId: project },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  });
  it('returns nothing for projects without includes or without newly inserted matches', async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([{ id: 'empty' }, { id: project }])
      .mockResolvedValueOnce([]);
    manager.find.mockResolvedValueOnce([]).mockResolvedValueOnce([rule]);
    expect(await service.addDiscoveredAssets(workspace, ['old'])).toEqual(
      new Map(),
    );
    expect(manager.query).toHaveBeenCalledTimes(2);
  });
  it('propagates transaction failures instead of reporting a partial batch', async () => {
    const { service, manager } = setup(),
      error = new Error('database failure');
    manager.query.mockRejectedValue(error);
    await expect(service.addDiscoveredAssets(workspace, ['new'])).rejects.toBe(
      error,
    );
  });
});
