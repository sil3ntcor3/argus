import type { Queue } from 'bullmq';
import type { RedisService } from '@/services/redis/redis.service';
import { ProjectTriggerBatchService } from './project-trigger-batch.service';

describe('ProjectTriggerBatchService', () => {
  function setup() {
    const client = {
      eval: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
    };
    const job = {
      id: 'queued',
      getState: jest.fn().mockResolvedValue('waiting'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    const queue = { add: jest.fn().mockResolvedValue(job) };
    return {
      client,
      queue,
      job,
      service: new ProjectTriggerBatchService(
        { client } as unknown as RedisService,
        queue as unknown as Queue,
      ),
    };
  }
  it('uses one stable queue identity for every event in a gather window', async () => {
    const { service, client, queue } = setup();
    client.eval.mockResolvedValue('window-token');
    await service.gather(
      'trigger',
      ['asset'],
      { runId: 'run', depth: 2 },
      10,
      'delivery',
    );
    await service.gather(
      'trigger',
      ['asset'],
      { runId: 'run', depth: 2 },
      10,
      'delivery',
    );
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    expect(queue.add).toHaveBeenCalledWith(
      'project-trigger',
      { triggerId: 'trigger', token: 'window-token' },
      expect.objectContaining({
        delay: 600000,
        attempts: 5,
        removeOnComplete: true,
      }),
    );
  });
  it('retains the same window after queue failure so redelivery can submit it', async () => {
    const { service, client, queue } = setup();
    client.eval.mockResolvedValue('window-token');
    queue.add
      .mockRejectedValueOnce(new Error('Redis queue unavailable'))
      .mockResolvedValueOnce({ getState: () => Promise.resolve('waiting') });
    await expect(
      service.gather('trigger', ['asset'], null, 0, 'delivery'),
    ).rejects.toThrow('Redis queue unavailable');
    await service.gather('trigger', ['asset'], null, 0, 'delivery');
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    expect(client.del).not.toHaveBeenCalled();
  });
  it('drains deduplicated assets with the deepest cause and ignores stale tokens', async () => {
    const { service, client } = setup();
    client.eval
      .mockResolvedValueOnce([
        ['a', 'b'],
        ['run', '3'],
      ])
      .mockResolvedValueOnce([]);
    await expect(service.take('trigger', 'token')).resolves.toEqual({
      assetIds: ['a', 'b'],
      cause: { runId: 'run', depth: 3 },
    });
    await expect(service.take('trigger', 'old-token')).resolves.toEqual({
      assetIds: [],
      cause: null,
    });
  });
  it('revives a terminally failed flush when its gather is redelivered', async () => {
    const { service, client, job } = setup();
    client.eval.mockResolvedValue('retained-token');
    job.getState.mockResolvedValue('failed');
    await service.gather('trigger', ['asset'], null, 0, 'delivery');
    expect(job.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
    });
  });
  it('acknowledges only the recoverable batch that finished handing off', async () => {
    const { service, client } = setup();
    await service.acknowledge('trigger', 'token');
    expect(client.hdel).toHaveBeenCalledWith(
      'project-trigger:trigger:inflight',
      'token',
    );
  });
  it('clears pending work without touching another trigger', async () => {
    const { service, client } = setup();
    await service.clear('first');
    expect(client.del).toHaveBeenCalledWith(
      'project-trigger:first:pending',
      'project-trigger:first:causes',
      'project-trigger:first:queued',
      'project-trigger:first:inflight',
    );
  });
});
