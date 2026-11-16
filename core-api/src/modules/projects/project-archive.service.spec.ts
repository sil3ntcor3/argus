import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import {
  ARCHIVE_PENDING,
  triggerCutoff,
  triggerEpoch,
} from './project-archive-state';
import { ProjectArchiveService } from './project-archive.service';
import type { ProjectLegacyScheduleService } from './project-legacy-schedule.service';
import type { ProjectMetadataReadService } from './project-metadata-read.service';
import type { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';

function fixture(archivedAt: Date | null = null) {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('FROM projects WHERE'))
      return [{ id: 'project', archivedAt }];
    if (sql.includes('SELECT id,"jobId"'))
      return [{ id: 'binding', jobId: 'old-key' }];
    if (sql.includes('SELECT tr.id')) return [{ id: 'trigger' }];
    if (sql.includes('clock_timestamp')) return [{ cutoff: '1794528000000' }];
    return [];
  });
  const manager = {
    query,
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const legacy = {
    remove: jest.fn().mockResolvedValue(undefined),
    reconcile: jest.fn().mockResolvedValue(undefined),
  };
  const runtime = { reconcile: jest.fn().mockResolvedValue(undefined) };
  const metadata = { getById: jest.fn().mockResolvedValue({ id: 'project' }) };
  const db = {
    transaction: jest.fn(async (fn: (m: typeof manager) => Promise<unknown>) =>
      fn(manager),
    ),
  };
  const service = new ProjectArchiveService(
    db as unknown as DataSource,
    legacy as unknown as ProjectLegacyScheduleService,
    runtime as unknown as ProjectTriggerRuntimeService,
    metadata as unknown as ProjectMetadataReadService,
  );
  return { service, manager, legacy, runtime, metadata };
}
describe('Project archive transition', () => {
  it.each([true, false])(
    'commits state and fresh delivery fences before schedule repair: archive=%s',
    async (archived) => {
      const f = fixture(archived ? null : new Date());
      await expect(
        f.service.setArchived('project', 'workspace', archived),
      ).resolves.toEqual({ id: 'project' });
      expect(f.manager.update).toHaveBeenCalledWith(
        AssetGroupWorkflow,
        { id: 'binding' },
        { jobId: expect.stringMatching(/^project-archive-pending:/) },
      );
      expect(f.manager.update).toHaveBeenCalledWith(
        AssetGroup,
        { id: 'project' },
        { archivedAt: archived ? expect.any(Date) : null },
      );
      const marker = f.manager.update.mock.calls.find(
        (call) => call[0] === ProjectWorkflowTrigger,
      )?.[2].schedulerId as string;
      expect(marker.startsWith(ARCHIVE_PENDING)).toBe(true);
      expect(triggerCutoff(marker)).toBe(1794528000000);
      expect(triggerEpoch(marker)).toBeDefined();
      expect(f.legacy.remove).toHaveBeenCalledWith([
        { id: 'binding', jobId: 'old-key' },
      ]);
      expect(f.legacy.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
        f.runtime.reconcile.mock.invocationCallOrder[0],
      );
    },
  );
  it.each([true, false])(
    'keeps repeated transitions idempotent: archive=%s',
    async (archived) => {
      const f = fixture(archived ? new Date() : null);
      await f.service.setArchived('project', 'workspace', archived);
      expect(f.manager.update).not.toHaveBeenCalled();
      expect(f.legacy.remove).toHaveBeenCalledWith([]);
    },
  );
  it('returns 404 without modifying a missing or foreign project', async () => {
    const f = fixture();
    f.manager.query.mockResolvedValue([]);
    await expect(
      f.service.setArchived('missing', 'workspace', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.manager.update).not.toHaveBeenCalled();
    expect(f.legacy.remove).not.toHaveBeenCalled();
  });
  it.each(['remove', 'legacy', 'runtime'])(
    'reports the durable state when %s Redis work fails',
    async (boundary) => {
      const f = fixture();
      if (boundary === 'runtime')
        f.runtime.reconcile.mockRejectedValue(new Error('offline'));
      else
        (boundary === 'remove'
          ? f.legacy.remove
          : f.legacy.reconcile
        ).mockRejectedValue(new Error('offline'));
      await expect(
        f.service.setArchived('project', 'workspace', true),
      ).resolves.toEqual({ id: 'project' });
      expect(f.metadata.getById).toHaveBeenCalledWith('project', 'workspace');
      expect(f.runtime.reconcile).toHaveBeenCalled();
    },
  );
});
