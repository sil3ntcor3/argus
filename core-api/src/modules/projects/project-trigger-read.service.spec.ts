import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { ProjectTriggerReadService } from './project-trigger-read.service';

describe('ProjectTriggerReadService', () => {
  const query = jest.fn();
  const service = new ProjectTriggerReadService({
    query,
  } as unknown as DataSource);
  const project = randomUUID(),
    workspace = randomUUID();
  const row = {
    id: randomUUID(),
    type: 'event',
    event: 'project.assets.added',
  };
  beforeEach(() => query.mockReset());
  it('returns only recognized safe fields and settings without mutating stored data', async () => {
    const config = {
      windowMinutes: 5,
      maxAssets: 200,
      targetTypes: ['DOMAIN', 'unknown'],
      workflows: ['Scan', 3],
      status: ['success', 'bad'],
      severity: ['critical', 'bad'],
      password: 'hidden',
    };
    query.mockResolvedValueOnce([{ id: project }]).mockResolvedValueOnce([
      { ...row, config, schedulerId: 'hidden', private: 'hidden' },
      { ...row, type: 'unknown', config: {} },
    ]);
    const before = JSON.stringify(config);
    expect(await service.list(project, workspace)).toEqual([
      {
        ...row,
        config: {
          windowMinutes: 5,
          maxAssets: 200,
          targetTypes: ['DOMAIN'],
          workflows: ['Scan'],
          status: ['success'],
          severity: ['critical'],
        },
      },
    ]);
    expect(JSON.stringify(config)).toBe(before);
  });
  it.each([
    null,
    [],
    5,
    { windowMinutes: -1, maxAssets: 5001, status: 'success', severity: [4] },
  ])('handles malformed stored settings: %j', async (config) => {
    query
      .mockResolvedValueOnce([{ id: project }])
      .mockResolvedValueOnce([{ ...row, event: 'unknown', config }]);
    expect((await service.list(project, workspace))[0]).toEqual({
      ...row,
      event: null,
      config:
        config && typeof config === 'object' && !Array.isArray(config)
          ? { severity: [] }
          : {},
    });
  });
  it('returns 404 for a missing scoped project', async () => {
    query.mockResolvedValueOnce([]);
    await expect(service.list(project, workspace)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('propagates database failures', async () => {
    const failure = new Error('storage unavailable');
    query.mockRejectedValueOnce(failure);
    await expect(service.list(project, workspace)).rejects.toBe(failure);
  });
});
