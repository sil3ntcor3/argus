import { WorkerScope } from '@/common/enums/enum';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { RedisService } from '@/services/redis/redis.service';
import {
  WORKER_STREAM_CANCEL_CHANNEL,
  WORKER_STREAM_JOBS_CHANNEL,
  WorkerStreamRegistry,
} from './worker-stream-registry.service';

describe('WorkerStreamRegistry', () => {
  let registry: WorkerStreamRegistry;
  let publish: jest.Mock;
  let handlers: Map<string, (channel: string, message: string) => void>;

  const deliver = (message: unknown) => {
    handlers.get(WORKER_STREAM_CANCEL_CHANNEL)?.(
      WORKER_STREAM_CANCEL_CHANNEL,
      JSON.stringify(message),
    );
  };

  beforeEach(async () => {
    publish = jest.fn().mockResolvedValue(1);
    handlers = new Map();
    const redis = {
      publish,
      subscribe: jest.fn(
        (channel: string, cb: (channel: string, message: string) => void) => {
          handlers.set(channel, cb);
          return Promise.resolve();
        },
      ),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService;

    const module = await Test.createTestingModule({
      providers: [WorkerStreamRegistry, { provide: RedisService, useValue: redis }],
    }).compile();

    registry = module.get(WorkerStreamRegistry);
    await registry.onModuleInit();
  });

  afterEach(() => {
    registry.onModuleDestroy();
  });

  it('delivers a cancel only to the newest stream for a worker', () => {
    // A reconnect replaces the stream. The stale teardown that follows must not
    // detach the new stream, and cancels must reach the live one.
    const stale = new Subject<Record<string, unknown>>();
    const staleReceived: Record<string, unknown>[] = [];
    stale.subscribe((value) => staleReceived.push(value));
    registry.register('worker-1', stale);

    const live = new Subject<Record<string, unknown>>();
    const liveReceived: Record<string, unknown>[] = [];
    live.subscribe((value) => liveReceived.push(value));
    registry.register('worker-1', live);

    // The replaced stream is closed by the registry, so anything subscribing to
    // it afterwards completes immediately.
    let staleCompleted = false;
    stale.subscribe({ complete: () => (staleCompleted = true) });
    expect(staleCompleted).toBe(true);
    staleReceived.length = 0;

    // A late teardown of the replaced stream must not unregister the live one.
    registry.unregister('worker-1', stale);

    deliver({ workerId: 'worker-1', jobId: 'job-1', reason: 'cancelled by user' });
    expect(liveReceived).toEqual([
      {
        cancel: {
          jobId: 'job-1',
          reason: 'cancelled by user',
          cancelledBy: undefined,
        },
      },
    ]);

    registry.unregister('worker-1', live);
    liveReceived.length = 0;
    deliver({ workerId: 'worker-1', jobId: 'job-2', reason: 'x' });
    expect(liveReceived).toHaveLength(0);
  });

  it('delivers a cancel to the instance holding the worker stream', () => {
    const subject = new Subject<Record<string, unknown>>();
    const received: Record<string, unknown>[] = [];
    subject.subscribe((value) => received.push(value));
    registry.register('worker-1', subject);

    deliver({
      workerId: 'worker-1',
      jobId: 'job-1',
      reason: 'cancelled by user',
    });

    expect(received).toEqual([
      {
        cancel: {
          jobId: 'job-1',
          reason: 'cancelled by user',
          cancelledBy: undefined,
        },
      },
    ]);
  });

  it('ignores cancels for workers another instance is streaming', () => {
    // No throw and no delivery: this instance holds no such stream.
    expect(() =>
      deliver({ workerId: 'worker-9', jobId: 'job-1', reason: 'x' }),
    ).not.toThrow();
  });

  it('ignores malformed and incomplete cancel payloads', () => {
    const subject = new Subject<Record<string, unknown>>();
    const received: Record<string, unknown>[] = [];
    subject.subscribe((value) => received.push(value));
    registry.register('worker-1', subject);

    handlers.get(WORKER_STREAM_CANCEL_CHANNEL)?.(
      WORKER_STREAM_CANCEL_CHANNEL,
      'not-json',
    );
    deliver({ workerId: 'worker-1' });

    expect(received).toHaveLength(0);
  });

  it('publishes cancels to every instance', async () => {
    await registry.publishCancel({
      workerId: 'worker-1',
      jobId: 'job-1',
      reason: 'run cancelled by user',
    });

    expect(publish).toHaveBeenCalledWith(
      WORKER_STREAM_CANCEL_CHANNEL,
      expect.stringContaining('"jobId":"job-1"'),
    );
  });
  it('routes cross-instance hints to matching workspace and cloud streams only', async () => {
    const peerHandlers = new Map<string, (channel: string, message: string) => void>();
    const peer = new WorkerStreamRegistry({
      subscribe: jest.fn((channel: string, handler: (channel: string, message: string) => void) => {
        peerHandlers.set(channel, handler);
        return Promise.resolve();
      }),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisService);
    await peer.onModuleInit();
    const collect = () => {
      const subject = new Subject<Record<string, unknown>>();
      const messages: Record<string, unknown>[] = [];
      subject.subscribe((message) => messages.push(message));
      return { subject, messages };
    };
    const own = collect();
    const other = collect();
    const cloud = collect();
    const unscoped = collect();
    peer.register('own', own.subject, { workspaceId: 'workspace-a' });
    peer.register('other', other.subject, { workspaceId: 'workspace-b' });
    peer.register('cloud', cloud.subject, { scope: WorkerScope.CLOUD });
    peer.register('unknown', unscoped.subject);
    publish.mockImplementation((channel: string, message: string) => {
      for (const handler of [...handlers.values(), ...peerHandlers.values()]) {
        handler(channel, message);
      }
      return Promise.resolve(2);
    });

    try {
      await registry.publishJobsAvailable('workspace-a');
      expect(publish).toHaveBeenCalledWith(WORKER_STREAM_JOBS_CHANNEL, 'workspace-a');
      expect(own.messages).toEqual([{ jobsAvailable: {} }]);
      expect(cloud.messages).toEqual([{ jobsAvailable: {} }]);
      expect(other.messages).toEqual([]);
      expect(unscoped.messages).toEqual([]);
    } finally {
      peer.onModuleDestroy();
    }
  });

  it('uses the reconnected stream owner and ignores stale teardown and empty hints', () => {
    const stale = new Subject<Record<string, unknown>>();
    const live = new Subject<Record<string, unknown>>();
    const messages: Record<string, unknown>[] = [];
    live.subscribe((message) => messages.push(message));
    registry.register('worker-1', stale, { workspaceId: 'workspace-a' });
    registry.register('worker-1', live, { workspaceId: 'workspace-b' });
    registry.unregister('worker-1', stale);
    const deliverHint = (workspace: string) => handlers.get(WORKER_STREAM_JOBS_CHANNEL)?.(
      WORKER_STREAM_JOBS_CHANNEL, workspace,
    );

    deliverHint('workspace-a');
    deliverHint('');
    expect(messages).toEqual([]);
    deliverHint('workspace-b');
    expect(messages).toEqual([{ jobsAvailable: {} }]);
    registry.unregister('worker-1', live);
    deliverHint('workspace-b');
    expect(messages).toHaveLength(1);
  });

  it('isolates Redis channels even when another channel carries a valid cancel', () => {
    const subject = new Subject<Record<string, unknown>>();
    const messages: Record<string, unknown>[] = [];
    subject.subscribe((message) => messages.push(message));
    registry.register('worker-1', subject, { workspaceId: 'workspace-a' });
    handlers.get(WORKER_STREAM_CANCEL_CHANNEL)?.(
      WORKER_STREAM_JOBS_CHANNEL,
      JSON.stringify({ workerId: 'worker-1', jobId: 'job-1' }),
    );
    handlers.get(WORKER_STREAM_JOBS_CHANNEL)?.(WORKER_STREAM_CANCEL_CHANNEL, 'workspace-a');
    expect(messages).toEqual([]);
  });

  it('continues routing a hint after another stream fails', () => {
    const broken = new Subject<Record<string, unknown>>();
    jest.spyOn(broken, 'next').mockImplementation(() => { throw new Error('stream closed'); });
    const live = new Subject<Record<string, unknown>>();
    const messages: Record<string, unknown>[] = [];
    live.subscribe((message) => messages.push(message));
    registry.register('broken', broken, { workspaceId: 'workspace-a' });
    registry.register('live', live, { scope: WorkerScope.CLOUD });

    expect(() => handlers.get(WORKER_STREAM_JOBS_CHANNEL)?.(
      WORKER_STREAM_JOBS_CHANNEL, 'workspace-a',
    )).not.toThrow();
    expect(messages).toEqual([{ jobsAvailable: {} }]);
  });

  it('surfaces Redis publication failure so the caller can retain fallback polling', async () => {
    publish.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(registry.publishJobsAvailable('workspace-a')).rejects.toThrow('Redis unavailable');
  });

});
