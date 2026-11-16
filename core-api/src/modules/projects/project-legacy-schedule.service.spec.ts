import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';
import { ProjectLegacyScheduleService } from './project-legacy-schedule.service';

function fixture(overrides = {}) {
  const row = {
    id: 'binding',
    projectId: 'project',
    workflowId: 'workflow',
    workspaceId: 'workspace',
    schedule: '0 8 * * *',
    jobId: 'old',
    archivedAt: null,
    ...overrides,
  };
  const builder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const manager = {
    query: jest
      .fn()
      .mockImplementation((sql: string) =>
        sql.includes('SELECT pw.id') ? [row] : [],
      ),
    createQueryBuilder: () => builder,
  };
  const db = {
    transaction: (fn: (m: typeof manager) => Promise<unknown>) => fn(manager),
  };
  const queue = {
    getJobScheduler: jest.fn().mockResolvedValue(null),
    removeJobScheduler: jest.fn().mockResolvedValue(true),
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ProjectLegacyScheduleService(
    db as unknown as DataSource,
    queue as unknown as Queue,
  );
  return { service, row, queue, builder, manager };
}
describe('Project legacy schedule repair', () => {
  it('creates a fresh identity and removes only the previously owned scheduler', async () => {
    const f = fixture();
    f.queue.getJobScheduler.mockResolvedValue({
      name: 'binding',
      pattern: '0 7 * * *',
    });
    await f.service.reconcile('project', 'workspace');
    expect(f.manager.query).toHaveBeenCalledWith(
      expect.stringContaining('p.id=$1'),
      ['project', 'workspace'],
    );
    expect(f.manager.query).toHaveBeenLastCalledWith(
      expect.stringContaining('FOR UPDATE OF pw'),
      [['binding'], ['project'], ['workflow'], ['workspace']],
    );
    expect(f.queue.upsertJobScheduler).toHaveBeenCalledWith(
      expect.stringMatching(/^project-legacy:binding:/),
      { pattern: '0 8 * * *', tz: 'UTC' },
      expect.objectContaining({ name: 'binding' }),
    );
    expect(f.queue.removeJobScheduler).toHaveBeenCalledWith('old');
  });
  it('retains an existing scheduler with matching identity and cron', async () => {
    const f = fixture();
    f.queue.getJobScheduler.mockResolvedValue({
      name: 'binding',
      pattern: '0 8 * * *',
    });
    await f.service.reconcile();
    expect(f.queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(f.builder.execute).not.toHaveBeenCalled();
  });
  it.each([
    { archivedAt: new Date() },
    { schedule: 'disabled' },
    { schedule: 'invalid' },
  ])(
    'pauses an inactive schedule without destroying its preference: %j',
    async (overrides) => {
      const f = fixture(overrides);
      f.queue.getJobScheduler.mockResolvedValue({ name: 'binding' });
      await f.service.reconcile();
      expect(f.queue.upsertJobScheduler).not.toHaveBeenCalled();
      expect(f.queue.removeJobScheduler).toHaveBeenCalledWith('old');
      expect(f.builder.set).toHaveBeenCalledWith({ jobId: null });
    },
  );
  it('removes a just-created scheduler if the binding was removed or changed', async () => {
    const f = fixture({ jobId: null });
    f.builder.execute.mockResolvedValue({ affected: 0 });
    await f.service.reconcile();
    expect(f.queue.removeJobScheduler).toHaveBeenCalledWith(
      f.queue.upsertJobScheduler.mock.calls[0][0],
    );
  });
  it('never deletes another owner scheduler or an absent key', async () => {
    const f = fixture();
    f.queue.getJobScheduler.mockResolvedValue({ name: 'other' });
    await f.service.remove([
      { id: 'binding', jobId: 'old' },
      { id: 'binding', jobId: null },
    ]);
    expect(f.queue.removeJobScheduler).not.toHaveBeenCalled();
    expect(f.queue.getJobScheduler).toHaveBeenCalledTimes(1);
  });
  it('propagates Redis failure to coordinated runtime repair', async () => {
    const f = fixture();
    f.queue.upsertJobScheduler.mockRejectedValue(new Error('offline'));
    await expect(f.service.reconcile()).rejects.toThrow('offline');
  });
});
