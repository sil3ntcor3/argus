import type { DataSource } from 'typeorm';
import type { Queue } from 'bullmq';
import type { WorkflowRunnerService } from '../jobs-registry/workflow-runner.service';
import type { ProjectTriggerBatchService } from './project-trigger-batch.service';
import { ProjectTriggerRuntimeService } from './project-trigger-runtime.service';

describe('Project trigger runtime reconciliation', () => {
  it('removes only owned obsolete schedulers and leaves legacy schedules intact', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const db = {
      transaction: (
        fn: (manager: { query: typeof query }) => Promise<unknown>,
      ) => fn({ query }),
    };
    const queue = {
      getJobSchedulers: jest
        .fn()
        .mockResolvedValue([
          { key: 'legacy-repeat' },
          { key: 'project-trigger:removed' },
        ]),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };
    const runtime = new ProjectTriggerRuntimeService(
      db as unknown as DataSource,
      {} as WorkflowRunnerService,
      queue as unknown as Queue,
      {} as ProjectTriggerBatchService,
    );
    await runtime.reconcile();
    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith(
      'project-trigger:removed',
    );
  });
});
