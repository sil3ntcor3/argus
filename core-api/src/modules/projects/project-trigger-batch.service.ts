import { RedisService } from '@/services/redis/redis.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';

export interface TriggerBatchCause {
  runId: string;
  depth: number;
}
export interface ProjectTriggerEventJob {
  triggerId: string;
  token: string;
  epoch?: string;
}
const TTL = 2 * 24 * 60 * 60;
// Gathering and draining are atomic across API replicas. A distinct token for
// each window keeps a delayed job from draining a newer window after disable.
const GATHER = `
local delivered = redis.call('GET', KEYS[4])
if delivered then
  if redis.call('GET', KEYS[3]) == delivered or redis.call('HEXISTS', KEYS[5], delivered) == 1 then
    return delivered
  end
  return 0
end
local token = redis.call('GET', KEYS[3]) or ARGV[2]
redis.call('SET', KEYS[4], token, 'EX', ARGV[1])
for i = 5, #ARGV do redis.call('SADD', KEYS[1], ARGV[i]) end
redis.call('EXPIRE', KEYS[1], ARGV[1])
if ARGV[3] ~= '' then
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[1])
end
redis.call('SET', KEYS[3], token, 'NX', 'EX', ARGV[1])
return token`;
const TAKE = `
local saved = redis.call('HGET', KEYS[4], ARGV[1])
if saved then return cjson.decode(saved) end
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return {} end
local assets = redis.call('SMEMBERS', KEYS[1])
local cause = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
redis.call('HSET', KEYS[4], ARGV[1], cjson.encode({assets, cause, tonumber(ARGV[3])}))
redis.call('EXPIRE', KEYS[4], ARGV[2])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return {assets, cause, tonumber(ARGV[3])}`;

@Injectable()
export class ProjectTriggerBatchService {
  constructor(
    private readonly redis: RedisService,
    @InjectQueue('project-trigger-events') private readonly queue: Queue,
  ) {}
  private keys(id: string, epoch?: string): [string, string, string, string] {
    return ['pending', 'causes', 'queued', 'inflight'].map(
      (suffix) => `project-trigger:${id}${epoch ? ':' + epoch : ''}:${suffix}`,
    ) as [string, string, string, string];
  }
  async gather(
    id: string,
    assets: string[],
    cause: TriggerBatchCause | null,
    windowMinutes: number,
    deliveryId: string,
    epoch?: string,
  ): Promise<void> {
    if (!assets.length) return;
    const keys = this.keys(id, epoch),
      token = randomUUID();
    const seen = `project-trigger:${id}:seen:${createHash('sha256').update(deliveryId).digest('hex')}`;
    const queuedToken = await this.redis.client.eval(
      GATHER,
      5,
      ...keys.slice(0, 3),
      seen,
      keys[3],
      TTL,
      token,
      cause?.runId ?? '',
      cause?.depth ?? 0,
      ...assets,
    );
    if (typeof queuedToken !== 'string') return;
    // Every gatherer submits the same job identity. If submission fails, stream
    // redelivery retries it; a concurrent gatherer cannot strand the window.
    const job = await this.queue.add(
      'project-trigger',
      { triggerId: id, token: queuedToken, ...(epoch ? { epoch } : {}) },
      {
        jobId: queuedToken,
        delay: windowMinutes * 60000,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    );
    if ((await job.getState()) === 'failed')
      await job.retry('failed', { resetAttemptsMade: true });
  }

  /** The caller must acknowledge only after a durable, replay-safe handoff. */
  async take(
    id: string,
    token: string,
    maxAssets?: number,
    epoch?: string,
  ): Promise<{
    assetIds: string[];
    cause: TriggerBatchCause | null;
    maxAssets?: number;
  }> {
    const result = (await this.redis.client.eval(
      TAKE,
      4,
      ...this.keys(id, epoch),
      token,
      TTL,
      maxAssets ?? 0,
    )) as [string[], string[], number] | [];
    const [assetIds = [], cause = [], limit = 0] = result;
    return {
      assetIds,
      ...(limit > 0 ? { maxAssets: limit } : {}),
      cause:
        cause.length === 2
          ? { runId: cause[0], depth: Number(cause[1]) }
          : null,
    };
  }
  async acknowledge(id: string, token: string, epoch?: string): Promise<void> {
    await this.redis.client.hdel(this.keys(id, epoch)[3], token);
  }
  async clear(id: string, epoch?: string): Promise<void> {
    await this.redis.client.del(...this.keys(id, epoch));
  }
}
