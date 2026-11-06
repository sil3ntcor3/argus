import { NotFoundException } from '@nestjs/common';
import { ProjectScopeReadService } from './project-scope-read.service';

const setup = () => {
  const query = jest.fn(),
    find = jest.fn().mockResolvedValue([]);
  const getRepository = jest.fn().mockReturnValue({ find });
  return {
    query,
    find,
    getRepository,
    service: new ProjectScopeReadService({ query, getRepository } as never),
  };
};
describe('ProjectScopeReadService', () => {
  it('rejects missing or foreign projects before reading rules', async () => {
    const { service, query, getRepository } = setup();
    query.mockResolvedValue([]);
    await expect(
      service.getScope('project', 'workspace'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(getRepository).not.toHaveBeenCalled();
  });
  it('uses the resolved UUID and private preference while omitting empty label/count queries', async () => {
    const { service, query, find } = setup();
    const id = '3f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f';
    query
      .mockResolvedValueOnce([{ id, autoAddAssets: false }])
      .mockResolvedValueOnce([]);
    expect(await service.getScope(id.toUpperCase(), 'workspace')).toEqual({
      rules: [],
      autoAddAssets: false,
      ruleAssets: 0,
      manualAssets: 0,
    });
    expect(find).toHaveBeenCalledWith({
      where: { projectId: id },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([id, 'workspace']);
  });
  it('propagates database failures', async () => {
    const { service, query } = setup(),
      error = new Error('database unavailable');
    query.mockRejectedValue(error);
    await expect(service.getScope('project', 'workspace')).rejects.toBe(error);
  });
});
