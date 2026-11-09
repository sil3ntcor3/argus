import { randomUUID } from 'node:crypto';
import { CronSchedule } from '@/common/enums/enum';
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { TargetOverviewService } from './target-overview.service';

describe('TargetOverviewService', () => {
  const id = randomUUID();
  const workspaceId = randomUUID();
  const access = { jobs: false, findings: false };
  const query = jest.fn();
  const getJobScheduler = jest.fn();
  const redis = { status: 'ready' };
  let service: TargetOverviewService;

  beforeEach(() => {
    query.mockReset();
    getJobScheduler.mockReset();
    redis.status = 'ready';
    service = new TargetOverviewService({ query } as unknown as DataSource, {
      client: Promise.resolve(redis),
      jobScheduler: Promise.resolve({ getScheduler: getJobScheduler }),
    });
  });

  it('returns numeric counts from one parameterized query', async () => {
    const counts = {
      totalAssets: 0,
      newAssets: 0,
      totalServices: 0,
      newServices: 0,
      openPorts: 0,
      exposure: { ports: [], technologies: [], statusCodes: [] },
    };
    query.mockResolvedValueOnce([
      {
        ...counts,
        scanSchedule: CronSchedule.DAILY,
        jobId: null,
        stale: false,
        daysSinceDiscovery: 1,
        expiringTlsServices: 0,
        lastRun: null,
        findings: null,
      },
    ]);
    await expect(service.getOverview(id, workspaceId, access)).resolves.toEqual(
      {
        ...counts,
        openVulnerabilities: null,
        newVulnerabilities: null,
        nextScanAt: null,
        lastRun: null,
        insights: [],
      },
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE t.id = $1 AND t."workspaceId" = $2'),
      [id, workspaceId, false, false],
    );
    expect(getJobScheduler).not.toHaveBeenCalled();
  });

  it('does not look up a disabled schedule with a retained repeat key', async () => {
    query.mockResolvedValueOnce([
      { scanSchedule: CronSchedule.DISABLED, jobId: 'stored-key' },
    ]);
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({
      nextScanAt: null,
    });
    expect(getJobScheduler).not.toHaveBeenCalled();
  });

  it('ignores a repeat key belonging to a different target or cron pattern', async () => {
    query.mockResolvedValue([
      { scanSchedule: CronSchedule.DAILY, jobId: 'stored-key' },
    ]);
    const next = Date.now() + 60_000;
    getJobScheduler
      .mockResolvedValueOnce({
        name: randomUUID(),
        pattern: CronSchedule.DAILY,
        next,
      })
      .mockResolvedValueOnce({ name: id, pattern: CronSchedule.WEEKLY, next });
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({
      nextScanAt: null,
    });
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({
      nextScanAt: null,
    });
    expect(getJobScheduler).toHaveBeenCalledWith('stored-key');
  });

  it('falls back to null for both a rejected and a stalled Redis lookup', async () => {
    query.mockResolvedValue([
      { scanSchedule: CronSchedule.DAILY, jobId: 'stored-key' },
    ]);
    getJobScheduler
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockReturnValueOnce(new Promise(() => {}));
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({
      nextScanAt: null,
    });
    await expect(
      Promise.all([
        service.getOverview(id, workspaceId, access),
        service.getOverview(id, workspaceId, access),
      ]),
    ).resolves.toMatchObject([{ nextScanAt: null }, { nextScanAt: null }]);
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({ nextScanAt: null });
    expect(getJobScheduler).toHaveBeenCalledTimes(2);
  });

  it('skips Redis commands while the connection is reconnecting', async () => {
    redis.status = 'reconnecting';
    query.mockResolvedValueOnce([
      { scanSchedule: CronSchedule.DAILY, jobId: 'stored-key' },
    ]);
    await expect(
      service.getOverview(id, workspaceId, access),
    ).resolves.toMatchObject({ nextScanAt: null });
    expect(getJobScheduler).not.toHaveBeenCalled();
  });

  it('limits outstanding lookups for different schedules', async () => {
    getJobScheduler.mockReturnValue(new Promise(() => {}));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        query.mockResolvedValueOnce([
          { scanSchedule: CronSchedule.DAILY, jobId: `stored-${index}` },
        ]);
        return service.getOverview(id, workspaceId, access);
      }),
    );
    expect(results.every(({ nextScanAt }) => nextScanAt === null)).toBe(true);
    expect(getJobScheduler).toHaveBeenCalledTimes(16);
  });

  it('throws 404 when no target matches the selected workspace', async () => {
    query.mockResolvedValueOnce([]);
    await expect(service.getOverview(id, workspaceId, access)).rejects.toThrow(
      NotFoundException,
    );
  });
});
