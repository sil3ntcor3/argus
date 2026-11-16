import { randomUUID } from 'node:crypto';
import { CronSchedule } from '@/common/enums/enum';
import type { DataSource } from 'typeorm';
import { TargetListEnrichmentService } from './target-list-enrichment.service';
import { TargetOverviewService } from './target-overview.service';

describe('TargetListEnrichmentService', () => {
  const workspace = randomUUID();
  const access = { jobs: true, findings: true, projects: true };
  const query = jest.fn();
  const next = jest.fn();
  const db = { query } as unknown as DataSource;
  const service = new TargetListEnrichmentService(db, {
    getNextScanAt: next,
  } as unknown as TargetOverviewService);
  const zeros = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const row = (id = randomUUID()) => ({
    id,
    jobId: 'schedule-' + id,
    scanSchedule: CronSchedule.DAILY,
    openVulnerabilities: zeros,
    scanProgress: null,
    projects: [],
  });
  beforeEach(() => {
    query.mockReset();
    next.mockReset().mockResolvedValue(null);
  });

  it('skips all storage and Redis reads for an empty page', async () => {
    await expect(service.enrich([], workspace, access)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('queries only the selected page and preserves row order without exposing private schedule keys', async () => {
    const first = row(),
      second = row();
    const at = new Date(Date.now() + 60_000);
    query.mockResolvedValue([second, first]);
    next.mockResolvedValue(at);
    const result = await service.enrich(
      [
        { id: first.id, value: 'first' },
        { id: second.id, value: 'second' },
      ],
      workspace,
      access,
    );
    expect(result.map((r) => r.value)).toEqual(['first', 'second']);
    expect(
      result.every((r) => r.nextScanAt === at && !Object.hasOwn(r, 'jobId')),
    ).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"workspaceId"=$2'),
      [[first.id, second.id], workspace, true, true, true],
    );
  });

  it('redacts each domain even if a stale internal read supplies unauthorized values', async () => {
    const record = {
      ...row(),
      scanProgress: { done: 2, total: 3 },
      projects: [
        {
          id: randomUUID(),
          name: 'Private project',
          assets: 1,
          hexColor: null,
        },
      ],
    };
    query.mockResolvedValue([record]);
    const [result] = await service.enrich([{ id: record.id }], workspace, {
      jobs: false,
      findings: false,
      projects: false,
    });
    expect(result).toMatchObject({
      openVulnerabilities: null,
      scanProgress: null,
      projects: null,
    });
    expect(query.mock.calls[0][1]).toEqual([
      [record.id],
      workspace,
      false,
      false,
      false,
    ]);
  });

  it('keeps missing targets unknown and propagates database failures', async () => {
    query.mockResolvedValue([]);
    const [result] = await service.enrich(
      [{ id: randomUUID() }],
      workspace,
      access,
    );
    expect(result).toMatchObject({
      openVulnerabilities: null,
      projects: null,
      scanProgress: null,
      nextScanAt: null,
    });
    query.mockRejectedValue(new Error('database unavailable'));
    await expect(
      service.enrich([{ id: randomUUID() }], workspace, access),
    ).rejects.toThrow('database unavailable');
  });

  it('bounds concurrency while completing a full healthy 100-target page', async () => {
    const records = Array.from({ length: 100 }, () => row());
    query.mockResolvedValue(records);
    let active = 0,
      peak = 0;
    next.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Date('2026-11-20T08:00:00Z');
    });
    const result = await service.enrich(
      records.map(({ id }) => ({ id })),
      workspace,
      access,
    );
    expect(result.every((r) => r.nextScanAt !== null)).toBe(true);
    expect(next).toHaveBeenCalledTimes(100);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('retains SQL enrichment when Redis rejects a schedule lookup', async () => {
    const record = row();
    query.mockResolvedValue([record]);
    const getScheduler = jest
      .fn()
      .mockRejectedValue(new Error('Redis unavailable'));
    const overview = new TargetOverviewService(db, {
      client: Promise.resolve({ status: 'ready' }),
      jobScheduler: Promise.resolve({ getScheduler }),
    });
    const reader = new TargetListEnrichmentService(db, overview);
    const [result] = await reader.enrich(
      [{ id: record.id }],
      workspace,
      access,
    );
    expect(result).toMatchObject({
      openVulnerabilities: zeros,
      projects: [],
      nextScanAt: null,
    });
  });

  it('does not queue a 100-target page behind stalled Redis commands', async () => {
    const records = Array.from({ length: 100 }, () => row());
    query.mockResolvedValue(records);
    const getScheduler = jest.fn().mockReturnValue(new Promise(() => {}));
    const overview = new TargetOverviewService(db, {
      client: Promise.resolve({ status: 'ready' }),
      jobScheduler: Promise.resolve({ getScheduler }),
    });
    const reader = new TargetListEnrichmentService(db, overview);
    const start = performance.now();
    const result = await reader.enrich(
      records.map(({ id }) => ({ id })),
      workspace,
      access,
    );
    expect(result).toHaveLength(100);
    expect(result.every((r) => r.nextScanAt === null)).toBe(true);
    expect(getScheduler.mock.calls.length).toBeLessThanOrEqual(16);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
