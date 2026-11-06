import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProjectScopePreviewService } from './project-scope-preview.service';

const setup = () => {
  const query = jest.fn();
  const normalizer = { normalizeRules: jest.fn().mockResolvedValue([]) };
  return {
    query,
    normalizer,
    service: new ProjectScopePreviewService(
      { query } as never,
      normalizer as never,
    ),
  };
};

describe('ProjectScopePreviewService', () => {
  it('checks project ownership before normalizing rule references', async () => {
    const { query, normalizer, service } = setup();
    query.mockResolvedValue([]);
    await expect(
      service.preview('workspace', [], 'foreign-project'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['foreign-project', 'workspace']);
    expect(normalizer.normalizeRules).not.toHaveBeenCalled();
  });

  it('propagates invalid rules without executing preview queries', async () => {
    const { query, normalizer, service } = setup();
    const error = new BadRequestException('Invalid rule');
    normalizer.normalizeRules.mockRejectedValue(error);
    await expect(service.preview('workspace', [])).rejects.toBe(error);
    expect(query).not.toHaveBeenCalled();
  });

  it('uses the resolved project UUID for manual membership counts', async () => {
    const { query, service } = setup();
    const id = '3f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f';
    query
      .mockResolvedValueOnce([{ id }])
      .mockResolvedValueOnce([{ ruleAssets: 0, total: 2 }]);
    expect(await service.preview('workspace', [], id.toUpperCase())).toEqual({
      ruleAssets: 0,
      total: 2,
      perRule: [],
    });
    expect(query.mock.calls[1][1]).toEqual([id, 'workspace']);
  });

  it('does not convert database failures into validation responses', async () => {
    const { query, service } = setup(),
      error = new Error('database unavailable');
    query.mockRejectedValue(error);
    await expect(service.preview('workspace', [])).rejects.toBe(error);
  });
});
