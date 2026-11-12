import { ProjectTriggerBatchService } from '@/modules/projects/project-trigger-batch.service';
import type { RedisService } from '@/services/redis/redis.service';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

describe('Project trigger gathering on Docker Redis', () => {
  const redis = new Redis(process.env.REDIS_URL!);
  const url = new URL(process.env.REDIS_URL!);
  const connection = {
    host: url.hostname,
    port: Number(url.port),
    password: url.password,
    db: Number(url.pathname.slice(1)),
  };
  const queue = new Queue(`trigger-test-${randomUUID()}`, { connection });
  const service = new ProjectTriggerBatchService(
    { client: redis } as unknown as RedisService,
    queue,
  );
  const triggers: string[] = [];
  const id = () => {
    const value = randomUUID();
    triggers.push(value);
    return value;
  };
  afterEach(async () => {
    await queue.drain(true);
  });
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    for (const trigger of triggers) {
      const keys = await redis.keys(`project-trigger:${trigger}:*`);
      if (keys.length) await redis.del(...keys);
    }
    await redis.quit();
  });
  it('coalesces concurrent deliveries once and carries the deepest causal run', async () => {
    const trigger = id();
    await Promise.all([
      service.gather(
        trigger,
        ['a', 'b'],
        { runId: 'first', depth: 1 },
        10,
        'first-delivery',
      ),
      service.gather(
        trigger,
        ['b', 'c'],
        { runId: 'deepest', depth: 3 },
        10,
        'second-delivery',
      ),
      service.gather(
        trigger,
        ['a', 'b'],
        { runId: 'first', depth: 1 },
        10,
        'first-delivery',
      ),
    ]);
    const jobs = (await queue.getDelayed()).filter(
      (job) => job.data.triggerId === trigger,
    );
    expect(jobs).toHaveLength(1);
    const batch = await service.take(trigger, jobs[0].data.token as string);
    expect(batch.assetIds.sort()).toEqual(['a', 'b', 'c']);
    expect(batch.cause).toEqual({ runId: 'deepest', depth: 3 });
    expect(await service.take(trigger, jobs[0].data.token as string)).toEqual(
      batch,
    );
    await service.acknowledge(trigger, jobs[0].data.token as string);
    await service.gather(trigger, ['a'], null, 10, 'first-delivery');
    expect(await service.take(trigger, jobs[0].data.token as string)).toEqual({
      assetIds: [],
      cause: null,
    });
  });
  it('cannot drain a newly enabled window using an old delayed job', async () => {
    const trigger = id();
    await service.gather(trigger, ['old'], null, 10, 'old');
    const oldToken = await redis.get(`project-trigger:${trigger}:queued`);
    await service.clear(trigger);
    await service.gather(trigger, ['new'], null, 10, 'new');
    expect(await service.take(trigger, oldToken!)).toEqual({
      assetIds: [],
      cause: null,
    });
    const token = await redis.get(`project-trigger:${trigger}:queued`);
    expect(await service.take(trigger, token!)).toEqual({
      assetIds: ['new'],
      cause: null,
    });
  });
  it('requeues a terminally failed flush on redelivery', async () => {
    const trigger = id();
    const worker = new Worker(
      queue.name,
      () => Promise.reject(new Error('flush interrupted before drain')),
      { connection },
    );
    try {
      const failed = new Promise<void>((resolve, reject) => {
        worker.on('failed', (job) => {
          if (job?.attemptsMade === 5) resolve();
        });
        worker.on('error', reject);
      });
      await service.gather(trigger, ['retained'], null, 0, 'delivery');
      await failed;
    } finally {
      await worker.close();
    }
    const token = await redis.get(`project-trigger:${trigger}:queued`);
    expect(await (await queue.getJob(token!))!.getState()).toBe('failed');
    await service.gather(trigger, ['retained'], null, 0, 'delivery');
    expect(await (await queue.getJob(token!))!.getState()).toBe('waiting');
    expect(await service.take(trigger, token!)).toEqual({
      assetIds: ['retained'],
      cause: null,
    });
  });
  it('recovers a terminal failure after drain without confusing a newer window', async () => {
    const trigger = id();
    const worker = new Worker(
      queue.name,
      async (job) => {
        const batch = await service.take(trigger, job.data.token as string);
        expect(batch.assetIds).toEqual(['original']);
        throw new Error('launch interrupted after drain');
      },
      { connection },
    );
    let token: string;
    try {
      const failed = new Promise<void>((resolve, reject) => {
        worker.on('failed', (job) => {
          if (job?.attemptsMade === 5) {
            token = job.id!;
            resolve();
          }
        });
        worker.on('error', reject);
      });
      await service.gather(trigger, ['original'], null, 0, 'original-delivery');
      await failed;
    } finally {
      await worker.close();
    }
    await service.gather(trigger, ['new'], null, 10, 'new-delivery');
    const newerToken = await redis.get(`project-trigger:${trigger}:queued`);
    await service.gather(trigger, ['original'], null, 0, 'original-delivery');
    expect(await (await queue.getJob(token!))!.getState()).toBe('waiting');
    expect(await service.take(trigger, token!)).toEqual({
      assetIds: ['original'],
      cause: null,
    });
    expect(await service.take(trigger, newerToken!)).toEqual({
      assetIds: ['new'],
      cause: null,
    });
    await service.acknowledge(trigger, token!);
    const add = jest.spyOn(queue, 'add');
    try {
      await service.gather(trigger, ['original'], null, 0, 'original-delivery');
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });
  it('recovers a failed queue submission on stream redelivery without losing gathered assets', async () => {
    const trigger = id(),
      add = jest.spyOn(queue, 'add');
    add.mockRejectedValueOnce(new Error('submission interrupted'));
    await expect(
      service.gather(trigger, ['retained'], null, 10, 'delivery'),
    ).rejects.toThrow('submission interrupted');
    add.mockRestore();
    await service.gather(trigger, ['retained'], null, 10, 'delivery');
    const jobs = (await queue.getDelayed()).filter(
      (job) => job.data.triggerId === trigger,
    );
    expect(jobs).toHaveLength(1);
    expect(await service.take(trigger, jobs[0].data.token as string)).toEqual({
      assetIds: ['retained'],
      cause: null,
    });
  });
});
