import {
  BullMQName,
  DataKind,
  JobPriority,
  JobRunType,
  JobStatus,
  TargetType,
  ToolCategory,
  WorkerScope,
  WorkerType,
} from '@/common/enums/enum';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { getQueueToken } from '@nestjs/bullmq';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { AssetGroupWorkflow } from '../asset-group/entities/asset-groups-workflows.entity';
import { ConnectorRegistryService } from '../connectors/connector-registry.service';
import { DataAdapterService } from '../data-adapter/data-adapter.service';
import { StorageService } from '../storage/storage.service';
import { ToolConfigProfilesService } from '../tools/tool-config-profiles.service';
import { ToolsService } from '../tools/tools.service';
import { WorkerStreamRegistry } from '../workers/worker-stream-registry.service';
import { WorkerInstance } from '../workers/entities/worker.entity';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { GetNextJobResult } from './dto/jobs-registry.dto';
import { JobErrorLog } from './entities/job-error-log.entity';
import { JobHistory } from './entities/job-history.entity';
import { Job } from './entities/job.entity';
import { JobsRegistryService } from './jobs-registry.service';
import type { AssetService } from '../assets/entities/asset-services.entity';
import { StepScopeLoader, type LoadedStepScope } from './step-scope.loader';
import type { ScopeWebService } from './step-inputs';

const originalScopeLoad = StepScopeLoader.prototype.load;
// Service fixtures represent the loader's already-filtered entity results.
function mockServiceScope(getRows: () => Promise<AssetService[]>) {
  return jest.spyOn(StepScopeLoader.prototype, 'load').mockImplementation(
    async function (this: StepScopeLoader, inputs, filter): Promise<LoadedStepScope> {
      if (!inputs.includes(DataKind.SERVICE) && !inputs.includes(DataKind.WEB)) {
        return originalScopeLoad.call(this, inputs, filter) as Promise<LoadedStepScope>;
      }
      const rows = (await getRows()).map((row) => ({ ...row, assetId: row.asset.id }));
      const web = new Map<string, ScopeWebService[]>();
      for (const row of rows) {
        web.set(row.assetId, [...(web.get(row.assetId) ?? []), { ...row, scheme: 'https' }]);
      }
      const assets = new Map(rows.map((row) => [row.assetId, row.asset]));
      return {
        assets,
        services: new Map(rows.map((row) => [row.id, row])),
        scope: {
          assets: [...assets.values()].map((asset) => ({
            id: asset.id, value: asset.value, isPrimary: asset.isPrimary,
            targetType: TargetType.DOMAIN,
          })),
          services: web, web,
        },
      };
    },
  );
}

const HOST = [TargetType.DOMAIN, TargetType.IP, TargetType.CIDR];

describe('JobsRegistryService', () => {
  let service: JobsRegistryService;
  const getDEK = jest.fn<Promise<Buffer | null>, [string]>();

  const mockJobRepository = {
    createQueryBuilder: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
    getManyAndCount: jest.fn(),
    getOne: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockResolvedValue([]),
    count: jest.fn(),
    exists: jest.fn(),
  };

  const mockJobHistoryRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockJobErrorLogRepository = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockAssetGroupWorkflowRepository = {
    createQueryBuilder: jest.fn(),
  };

  let mockAssetGroupWorkflowQB: {
    select: jest.Mock;
    innerJoin: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getOne: jest.Mock;
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(),
    getRepository: jest.fn(),
    transaction: jest.fn(),
  };

  const mockDataAdapterService = {
    syncData: jest.fn(),
  };

  const mockStorageService = {
    upload: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue({ path: 'job-results/file.json' }),
  };
  const mockJobResultQueue = {
    add: jest.fn().mockResolvedValue({ id: 'queued-job', queueName: 'job-result' }),
  };

  const mockToolsService = {
    getInstalledTools: jest.fn(),
    getToolByNames: jest.fn(),
  };

  const mockWorkspacesService = {
    getWorkspaceConfigValue: jest.fn(),
  };

  const mockConnectorRegistryService = {
    getConnector: jest.fn(),
    getAllConnectors: jest.fn().mockReturnValue([]),
  };

    const mockToolConfigProfilesService = {
    assertProfileOwnership: jest.fn(),
    resolveConfigForDispatch: jest.fn(),
    resolveConfigForJob: jest.fn(),
  };

  const mockWorkerStreamRegistry = {
    publishCancel: jest.fn().mockResolvedValue(undefined),
    publishJobsAvailable: jest.fn().mockResolvedValue(undefined),
    register: jest.fn(),
    unregister: jest.fn(),
  };

  beforeEach(async () => {
    mockDataSource.transaction.mockImplementation(
      async (callback: (manager: EntityManager) => Promise<unknown>) =>
        callback({ getRepository: mockDataSource.getRepository } as unknown as EntityManager),
    );
    mockAssetGroupWorkflowQB = {
      select: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    mockAssetGroupWorkflowRepository.createQueryBuilder.mockReturnValue(
      mockAssetGroupWorkflowQB,
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(Job),
          useValue: mockJobRepository,
        },
        {
          provide: getRepositoryToken(JobHistory),
          useValue: mockJobHistoryRepository,
        },
        {
          provide: getRepositoryToken(JobErrorLog),
          useValue: mockJobErrorLogRepository,
        },
        {
          provide: getRepositoryToken(AssetGroupWorkflow),
          useValue: mockAssetGroupWorkflowRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: DataAdapterService,
          useValue: mockDataAdapterService,
        },
        {
          provide: StorageService,
          useValue: mockStorageService,
        },
        {
          provide: ToolsService,
          useValue: mockToolsService,
        },
        {
          provide: WorkspacesService,
          useValue: mockWorkspacesService,
        },
        {
          provide: getQueueToken(BullMQName.JOB_RESULT),
          useValue: mockJobResultQueue,
        },
        {
          provide: EventEmitter2,
          useValue: { emit: jest.fn() },
        },
        {
          provide: ConnectorRegistryService,
          useValue: mockConnectorRegistryService,
        },
        {
          provide: ToolConfigProfilesService,
          useValue: mockToolConfigProfilesService,
        },
        { provide: WorkspaceEncryptionService, useValue: { getDEK } },
        {
          provide: WorkerStreamRegistry,
          useValue: mockWorkerStreamRegistry,
        },
        JobsRegistryService,
      ],
    }).compile();

    service = module.get<JobsRegistryService>(JobsRegistryService);
    // Manually set optional toolsService since @Optional() dependencies may not be injected in tests
    (service as any).toolsService = mockToolsService;
    // The mocks are module-scoped, so cancel pushes must not leak between tests.
    mockWorkerStreamRegistry.publishCancel.mockClear();
    mockWorkerStreamRegistry.publishJobsAvailable.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    [true, false, ToolCategory.VULNERABILITIES, true],
    [undefined, false, ToolCategory.VULNERABILITIES, undefined],
    [true, true, ToolCategory.VULNERABILITIES, undefined],
    [true, false, ToolCategory.PORTS_SCANNER, undefined],
  ])('only queues trusted coverage %s from successful vulnerability reports', async (trusted, error, category, expected) => {
    mockJobResultQueue.add.mockClear();
    const dto = { jobId: 'job-id', error, coverageComplete: true };
    await service.updateResultByCategory('worker-id', dto, category, trusted);

    const [, result] = mockJobResultQueue.add.mock.calls[0] as [string, { coverageComplete?: boolean }];
    expect(result.coverageComplete).toBe(expected);
  });

  it.each([
    ['sha256:' + 'a'.repeat(64), false, ToolCategory.VULNERABILITIES, true],
    ['sha256:invalid', false, ToolCategory.VULNERABILITIES, false],
    ['sha256:' + 'A'.repeat(64), false, ToolCategory.VULNERABILITIES, false],
    ['sha256:' + 'a'.repeat(64), true, ToolCategory.VULNERABILITIES, false],
    ['sha256:' + 'a'.repeat(64), false, ToolCategory.PORTS_SCANNER, false],
    [undefined, false, ToolCategory.VULNERABILITIES, false],
  ])('only queues a canonical trusted connector image (%s)', async (image, error, category, expected) => {
    mockJobResultQueue.add.mockClear();
    const dto = { jobId: 'job-id', error, connectorImageId: 'sha256:' + 'b'.repeat(64) };
    await service.updateResultByCategory('worker-id', dto, category, undefined, image);

    const [, result] = mockJobResultQueue.add.mock.calls[0] as [string, { connectorImageId?: string }];
    expect(result.connectorImageId).toBe(expected ? image : undefined);
  });

  it('stages separate objects for same-millisecond coverage and legacy results', async () => {
    mockStorageService.uploadFile.mockClear();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      await service.updateResultByCategory(
        'worker-id', { jobId: 'job-id', error: false }, ToolCategory.VULNERABILITIES, true,
      );
      await service.updateResult('worker-id', {
        jobId: 'job-id', data: { error: false, payload: [] },
      });
      const uploads = mockStorageService.uploadFile.mock.calls as [string, Buffer, string][];
      const keys = uploads.map(([key]) => key);
      expect(new Set(keys).size).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  describe('reRunJob', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockJobId = 'job-uuid';
    const mockJob = {
      id: mockJobId,
      status: JobStatus.COMPLETED,
      workerId: 'worker-uuid',
      retryCount: 0,
      asset: {
        target: {
          id: 'target-uuid',
        },
      },
    };

    it.each([false, true])('commits a re-run before its best-effort hint (Redis failure: %s)', async (failHint) => {
      if (failHint) mockWorkerStreamRegistry.publishJobsAvailable.mockRejectedValueOnce(new Error('Redis unavailable'));
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          save: jest.fn().mockResolvedValue({
            ...mockJob,
            status: JobStatus.PENDING,
            workerId: undefined,
            retryCount: 1,
          }),
        },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue({ ...mockJob, retryCount: 0 });

      const result = await service.reRunJob(mockWorkspaceId, mockJobId);

      expect(mockJobRepository.createQueryBuilder).toHaveBeenCalledWith('job');
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Job re-run successfully' });
      expect(mockWorkerStreamRegistry.publishJobsAvailable).toHaveBeenCalledWith(mockWorkspaceId);
      expect(mockQueryRunner.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        mockWorkerStreamRegistry.publishJobsAvailable.mock.invocationCallOrder[0],
      );

      // Verify the job was updated correctly
      expect(mockQueryRunner.manager.save).toHaveBeenCalledWith({
        ...mockJob,
        status: JobStatus.PENDING,
        workerId: undefined,
        retryCount: 1,
        findingScanCoverageComplete: null,
      });
    });

    it('should throw NotFoundException when job not found in workspace', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(null);

      await expect(
        service.reRunJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.reRunJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Job not found in workspace');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should rollback transaction when error occurs', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          save: jest.fn(),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockRejectedValue(new Error('Database error'));

      await expect(
        service.reRunJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Database error');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockWorkerStreamRegistry.publishJobsAvailable).not.toHaveBeenCalled();
    });
  });

  describe('cancelJob', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockJobId = 'job-uuid';
    const mockJob = {
      id: mockJobId,
      status: JobStatus.IN_PROGRESS,
      workerId: 'worker-uuid',
      retryCount: 0,
      asset: {
        target: {
          id: 'target-uuid',
        },
      },
    };

    it('should successfully cancel a job', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          save: jest.fn().mockResolvedValue({
            ...mockJob,
            status: JobStatus.CANCELLED,
          }),
        },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(mockJob);

      const result = await service.cancelJob(mockWorkspaceId, mockJobId);

      expect(mockJobRepository.createQueryBuilder).toHaveBeenCalledWith('job');
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Job cancelled successfully' });

      // Verify the job status was updated to cancelled
      expect(mockQueryRunner.manager.save).toHaveBeenCalledWith({
        ...mockJob,
        status: JobStatus.CANCELLED,
      });
    });

    it('publishes a cancel to the worker stream when the job was running', async () => {
      // Given: a job that a worker is executing right now
      const runningJob = {
        id: mockJobId,
        status: JobStatus.IN_PROGRESS,
        workerId: 'worker-uuid',
        retryCount: 0,
        asset: { target: { id: 'target-uuid' } },
      };
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: { save: jest.fn().mockResolvedValue(runningJob) },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };
      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(runningJob);
      mockWorkerStreamRegistry.publishCancel.mockClear();

      // When: the job is cancelled from the console
      await service.cancelJob(mockWorkspaceId, mockJobId);

      // Then: the owning worker is told to stop, after the DB commit
      expect(mockWorkerStreamRegistry.publishCancel).toHaveBeenCalledWith({
        workerId: 'worker-uuid',
        jobId: mockJobId,
        reason: 'cancelled by user',
      });
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('does not publish a cancel when no worker was running the job', async () => {
      // Given: a queued job that no worker has picked up
      const pendingJob = {
        id: mockJobId,
        status: JobStatus.PENDING,
        retryCount: 0,
        asset: { target: { id: 'target-uuid' } },
      };
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: { save: jest.fn().mockResolvedValue(pendingJob) },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };
      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(pendingJob);
      mockWorkerStreamRegistry.publishCancel.mockClear();

      // When
      await service.cancelJob(mockWorkspaceId, mockJobId);

      // Then: nobody is told to stop anything
      expect(mockWorkerStreamRegistry.publishCancel).not.toHaveBeenCalled();
    });

    it('still reports success when publishing the cancel fails', async () => {
      // Given: a running job whose stream cannot be reached
      const runningJob = {
        id: mockJobId,
        status: JobStatus.IN_PROGRESS,
        workerId: 'worker-uuid',
        retryCount: 0,
        asset: { target: { id: 'target-uuid' } },
      };
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: { save: jest.fn().mockResolvedValue(runningJob) },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };
      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(runningJob);
      mockWorkerStreamRegistry.publishCancel.mockRejectedValueOnce(
        new Error('redis down'),
      );

      // When / Then: the cancellation itself still succeeds (best-effort push)
      await expect(
        service.cancelJob(mockWorkspaceId, mockJobId),
      ).resolves.toEqual({ message: 'Job cancelled successfully' });
    });

    it('should throw NotFoundException when job not found in workspace', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(null);

      await expect(
        service.cancelJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.cancelJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Job not found in workspace');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should rollback transaction when error occurs', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockRejectedValue(new Error('Database error')),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockRejectedValue(new Error('Database error'));

      await expect(
        service.cancelJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Database error');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('cancelJobHistory', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockHistoryId = 'history-uuid';

    const buildQueryRunner = ({
      belongsToWorkspace = true,
      affected = 3,
      running = [] as { jobId: string; workerId: string }[],
      steps = {},
      isCompleted = false,
    } = {}) => {
      const ownershipBuilder = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getExists: jest.fn().mockResolvedValue(belongsToWorkspace),
      };
      const runningBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(running),
      };
      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected }),
      };
      const findOne = jest.fn().mockResolvedValue({
        id: mockHistoryId,
        steps,
        isCompleted,
      });
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const manager = {
        // Three shapes: the 'jobHistory' alias is the ownership lookup, the
        // 'job' alias is the "which jobs are executing right now" lookup, and
        // no alias is the bulk update.
        createQueryBuilder: jest.fn((entity?: unknown, alias?: string) => {
          if (alias === 'job') return runningBuilder;
          return entity ? ownershipBuilder : updateBuilder;
        }),
        findOne,
        update,
      };

      return {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager,
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        ownershipBuilder,
        runningBuilder,
        updateBuilder,
        findOne,
        update,
      };
    };

    it('cancels every job of the run, keeping the completion time of finished ones', async () => {
      const qr = buildQueryRunner({ affected: 100 });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      const result = await service.cancelJobHistory(
        mockWorkspaceId,
        mockHistoryId,
      );

      // COALESCE keeps the real completedAt so an already-finished job does not
      // look like it completed at cancel time.
      expect(qr.updateBuilder.set).toHaveBeenCalledWith({
        status: JobStatus.CANCELLED,
        completedAt: expect.any(Function),
      });
      expect(qr.updateBuilder.where).toHaveBeenCalledWith(
        '"jobHistoryId" = :jobHistoryId',
        { jobHistoryId: mockHistoryId },
      );
      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(result.message).toContain('100');
      // Nothing was executing, so no worker is told to stop.
      expect(mockWorkerStreamRegistry.publishCancel).not.toHaveBeenCalled();
    });

    it('stops every job of the run that a worker was executing', async () => {
      const qr = buildQueryRunner({
        affected: 2,
        running: [
          { jobId: 'job-a', workerId: 'worker-1' },
          { jobId: 'job-b', workerId: 'worker-2' },
        ],
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);
      mockWorkerStreamRegistry.publishCancel.mockClear();

      await service.cancelJobHistory(mockWorkspaceId, mockHistoryId);

      expect(mockWorkerStreamRegistry.publishCancel).toHaveBeenCalledTimes(2);
      expect(mockWorkerStreamRegistry.publishCancel).toHaveBeenCalledWith({
        workerId: 'worker-1',
        jobId: 'job-a',
        reason: 'run cancelled by user',
      });
      expect(mockWorkerStreamRegistry.publishCancel).toHaveBeenCalledWith({
        workerId: 'worker-2',
        jobId: 'job-b',
        reason: 'run cancelled by user',
      });
    });

    it('closes the run so no further step can ever be dispatched', async () => {
      const qr = buildQueryRunner({
        steps: {
          'Port Scan': { status: 'pending', jobs: 0 },
          'HTTP Probe': { status: 'dispatched', jobs: 2 },
          'Vuln Scan': { status: 'done', jobs: 1 },
        },
      });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await service.cancelJobHistory(mockWorkspaceId, mockHistoryId);

      const [, , patch]: [unknown, unknown, Record<string, unknown>] = qr
        .update.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
      expect(qr.update).toHaveBeenCalledWith(
        JobHistory,
        { id: mockHistoryId },
        expect.objectContaining({ isCompleted: true }),
      );
      expect(patch.steps).toMatchObject({
        'Port Scan': { status: 'skipped', reason: 'run-cancelled' },
        'HTTP Probe': { status: 'skipped', reason: 'run-cancelled' },
        'Vuln Scan': { status: 'done' },
      });
    });

    it('rejects a closed run under the workflow lock before touching jobs', async () => {
      const qr = buildQueryRunner({ isCompleted: true });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await expect(
        service.cancelJobHistory(mockWorkspaceId, mockHistoryId),
      ).rejects.toThrow(ConflictException);

      expect(qr.findOne).toHaveBeenCalledWith(JobHistory, {
        where: { id: mockHistoryId },
        lock: { mode: 'for_no_key_update' },
      });
      expect(qr.runningBuilder.getRawMany).not.toHaveBeenCalled();
      expect(qr.updateBuilder.execute).not.toHaveBeenCalled();
      expect(qr.update).not.toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
      expect(mockWorkerStreamRegistry.publishCancel).not.toHaveBeenCalled();
    });

    it('throws NotFoundException and rolls back for a history outside the workspace', async () => {
      const qr = buildQueryRunner({ belongsToWorkspace: false });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await expect(
        service.cancelJobHistory(mockWorkspaceId, mockHistoryId),
      ).rejects.toThrow(NotFoundException);

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.updateBuilder.execute).not.toHaveBeenCalled();
      expect(qr.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a history that does not exist', async () => {
      const qr = buildQueryRunner({ belongsToWorkspace: false });
      mockDataSource.createQueryRunner.mockReturnValue(qr);

      await expect(
        service.cancelJobHistory(mockWorkspaceId, 'missing-history'),
      ).rejects.toThrow(NotFoundException);
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('deleteJob', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockJobId = 'job-uuid';
    const mockJob = {
      id: mockJobId,
      status: JobStatus.COMPLETED,
      workerId: 'worker-uuid',
      retryCount: 0,
      asset: {
        target: {
          id: 'target-uuid',
        },
      },
    };

    it('should successfully delete a job', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          remove: jest.fn().mockResolvedValue(mockJob),
        },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(mockJob);

      const result = await service.deleteJob(mockWorkspaceId, mockJobId);

      expect(mockJobRepository.createQueryBuilder).toHaveBeenCalledWith('job');
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toEqual({ message: 'Job deleted successfully' });

      // Verify the job was removed
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(mockJob);
    });

    it('should throw NotFoundException when job not found in workspace', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockResolvedValue(null);

      await expect(
        service.deleteJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.deleteJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Job not found in workspace');

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('should rollback transaction when error occurs', async () => {
      const mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockRejectedValue(new Error('Database error')),
        },
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      mockJobRepository.getOne.mockRejectedValue(new Error('Database error'));

      await expect(
        service.deleteJob(mockWorkspaceId, mockJobId),
      ).rejects.toThrow('Database error');
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('getJobHistoryDetail', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockHistoryId = 'history-uuid';
    const mockJobs = [
      {
        id: 'job-1',
        status: JobStatus.COMPLETED,
        tool: { name: 'test-tool' },
      },
    ];
    const mockJobHistory = {
      id: mockHistoryId,
      createdAt: new Date(),
      updatedAt: new Date(),
      jobs: mockJobs,
      steps: {},
      workflow: {
        name: 'test-workflow',
        content: {
          jobs: { test_step: { name: 'Test Step', run: 'test-tool' } },
        },
      },
      jobHistoryName: 'test-job-history',
    };

    it('should return job history detail with tools and their statuses', async () => {
      const mockTool = {
        id: 'tool-uuid',
        name: 'test-tool',
        description: 'A test tool',
        command: 'test-command',
        categories: [{ name: ToolCategory.SUBDOMAINS, targetTypes: HOST }],
        version: '1.0',
        logoUrl: 'http://example.com/logo.png',
        isBuiltIn: true,
        isInstalled: true,
        isOfficialSupport: true,
        type: WorkerType.BUILT_IN,
        providerId: 'provider-uuid',
        priority: JobPriority.BACKGROUND,
        availableWorkersCount: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockJobHistoryRepository.findOne.mockResolvedValue(mockJobHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([
        { toolId: 'tool-uuid', status: JobStatus.COMPLETED },
      ]);
      mockToolsService.getInstalledTools.mockResolvedValue({
        data: [mockTool],
      });

      const result = await service.getJobHistoryDetail(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(mockJobHistoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockHistoryId },
        relations: {
          workflow: true,
        },
      });
      expect(result).toEqual({
        id: mockHistoryId,
        workflowName: 'test-workflow',
        jobHistoryName: 'test-job-history',
        etaSeconds: null,
        failureReason: null,
        retryAvailable: false,
        createdAt: mockJobHistory.createdAt,
        updatedAt: mockJobHistory.updatedAt,
        tools: [
          {
            id: 'tool-uuid',
            name: 'test-tool',
            logoUrl: 'http://example.com/logo.png',
            status: JobStatus.COMPLETED,
          },
        ],
        steps: [
          {
            id: 'test_step',
            name: 'Test Step',
            run: 'test-tool',
            category: 'subdomains',
            needs: [],
            // Derived from the job rows for a run created before the engine.
            status: 'done',
            jobs: 0,
            toolId: 'tool-uuid',
            logoUrl: 'http://example.com/logo.png',
          },
        ],
      });
      // Bandwidth contract: tools must expose only id/name/logoUrl/status
      expect(Object.keys(result.tools![0]).sort()).toEqual([
        'id',
        'logoUrl',
        'name',
        'status',
      ]);
    });

    it('should report a tool as cancelled rather than completed once the run was cancelled', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValue(mockJobHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });

      await service.getJobHistoryDetail(mockWorkspaceId, mockHistoryId);

      // The tool status query is not the only one on the job repository, so
      // look for its CASE expression across every select call.
      const selectArgs = (mockJobRepository.select.mock.calls as unknown[][])
        .map(([arg]) => arg)
        .filter((arg): arg is string[] => Array.isArray(arg))
        .flat();
      const statusExpr = selectArgs.find((s) => s.includes('CASE'))!;
      // Regression: a tool whose jobs finished before the cancel used to keep a
      // green check, because the COMPLETED branch was reached first.
      expect(statusExpr).toContain(
        `WHEN COUNT(CASE WHEN job.status = '${JobStatus.CANCELLED}' THEN 1 END) > 0`,
      );
      expect(statusExpr.indexOf(JobStatus.CANCELLED)).toBeLessThan(
        statusExpr.indexOf(JobStatus.COMPLETED),
      );
    });

    it('should return detail for a history whose jobs were all deleted (ownership proven via workflow, tool status undefined)', async () => {
      const mockTool = {
        id: 'tool-uuid',
        name: 'test-tool',
        logoUrl: 'http://example.com/logo.png',
      };

      mockJobHistoryRepository.findOne.mockResolvedValue(mockJobHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      // No job rows: the deleted-jobs scenario
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({
        data: [mockTool],
      });

      const result = await service.getJobHistoryDetail(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result).toEqual({
        id: mockHistoryId,
        workflowName: 'test-workflow',
        jobHistoryName: 'test-job-history',
        etaSeconds: null,
        failureReason: null,
        retryAvailable: false,
        createdAt: mockJobHistory.createdAt,
        updatedAt: mockJobHistory.updatedAt,
        tools: [
          {
            id: 'tool-uuid',
            name: 'test-tool',
            logoUrl: 'http://example.com/logo.png',
            status: undefined,
          },
        ],
        steps: [
          {
            id: 'test_step',
            name: 'Test Step',
            run: 'test-tool',
            needs: [],
            status: 'pending',
            jobs: 0,
            toolId: 'tool-uuid',
            logoUrl: 'http://example.com/logo.png',
          },
        ],
      });
    });

    it('exposes the persisted step state of a DAG run', async () => {
      const dagHistory = {
        ...mockJobHistory,
        steps: {
          scan_subdomain: {
            status: 'done',
            jobs: 1,
            dispatchedAt: '2026-01-01T00:00:00.000Z',
            finishedAt: '2026-01-01T00:05:00.000Z',
          },
          port_scan: { status: 'dispatched', jobs: 3, failed: 1 },
          http_probe: {
            status: 'skipped',
            jobs: 0,
            reason: 'blocked-by-failure',
          },
        },
        workflow: {
          name: 'test-workflow',
          content: {
            // Stored in jsonb key order, NOT authored order, exactly as Postgres
            // hands it back — the response must still come out dependencies-first.
            jobs: {
              http_probe: {
                name: 'HTTP Probe',
                run: 'httpx',
                needs: ['port_scan'],
              },
              take_screenshot: {
                name: 'Take Screenshot',
                run: 'screenshot',
                needs: ['http_probe'],
              },
              scan_subdomain: {
                name: 'Scan Subdomain',
                run: 'subfinder',
              },
              port_scan: {
                name: 'Port Scan',
                run: 'naabu',
                needs: ['scan_subdomain'],
              },
            },
          },
        },
      };
      mockJobHistoryRepository.findOne.mockResolvedValue(dagHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });

      const result = await service.getJobHistoryDetail(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result.steps).toEqual([
        {
          id: 'scan_subdomain',
          name: 'Scan Subdomain',
          run: 'subfinder',
          needs: [],
          status: 'done',
          jobs: 1,
          dispatchedAt: new Date('2026-01-01T00:00:00.000Z'),
          finishedAt: new Date('2026-01-01T00:05:00.000Z'),
        },
        {
          id: 'port_scan',
          name: 'Port Scan',
          run: 'naabu',
          needs: ['scan_subdomain'],
          status: 'dispatched',
          jobs: 3,
          failed: 1,
        },
        {
          id: 'http_probe',
          name: 'HTTP Probe',
          run: 'httpx',
          needs: ['port_scan'],
          status: 'skipped',
          reason: 'blocked-by-failure',
          jobs: 0,
        },
        {
          id: 'take_screenshot',
          name: 'Take Screenshot',
          run: 'screenshot',
          needs: ['http_probe'],
          status: 'pending',
          jobs: 0,
        },
      ]);
    });

    it('lists each step with its category and the legacy tool list once per tool', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValue({
        ...mockJobHistory,
        steps: {},
        workflow: {
          name: 'test-workflow',
          content: {
            jobs: {
              ports: { run: 'nmap', category: 'ports_scanner' },
              vulns: { run: 'nmap', category: 'vulnerabilities', needs: ['ports'] },
              probe: { run: 'httpx', needs: ['vulns'] },
            },
          },
        },
      });
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({
        data: [
          {
            id: 'tool-nmap',
            name: 'nmap',
            categories: [
              { name: ToolCategory.PORTS_SCANNER, targetTypes: [] },
              { name: ToolCategory.VULNERABILITIES, targetTypes: [] },
            ],
          },
          {
            id: 'tool-httpx',
            name: 'httpx',
            categories: [{ name: ToolCategory.HTTP_PROBE, targetTypes: [] }],
          },
        ],
      });

      const result = await service.getJobHistoryDetail(mockWorkspaceId, mockHistoryId);

      expect(result.steps!.map((step) => [step.id, step.category])).toEqual([
        ['ports', 'ports_scanner'],
        ['vulns', 'vulnerabilities'],
        ['probe', 'http_probe'],
      ]);
      expect(result.tools!.map((tool) => tool.name)).toEqual(['nmap', 'httpx']);
    });

    it.each([
      { label: 'even median', durations: [50, 150], expected: 50 },
      { label: 'odd median', durations: [999, 150, 50], expected: 75 },
      {
        label: 'insufficient valid history',
        durations: [50, 0, -5],
        expected: null,
      },
      { label: 'closed run', closed: true, expected: null },
      { label: 'idle run', active: 0, expected: null },
      { label: 'legacy run', legacy: true, expected: null },
      { label: 'no settled steps', settled: 'pending', expected: null },
    ])(
      'returns the run ETA for $label',
      async ({
        durations,
        expected,
        closed = false,
        active = 1,
        legacy,
        settled = 'done',
      }) => {
        mockJobHistoryRepository.findOne.mockResolvedValue({
          ...mockJobHistory,
          isCompleted: closed,
          workflow: {
            ...mockJobHistory.workflow,
            id: 'workflow-uuid',
            content: {
              jobs: {
                ...mockJobHistory.workflow.content.jobs,
                next_step: { run: 'test-tool' },
              },
            },
          },
          steps: legacy
            ? {}
            : {
                test_step: { status: settled, jobs: 1 },
                next_step: { status: 'dispatched', jobs: 2 },
              },
        });
        const authorization = {
          innerJoin: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({
            projectId: null,
            projectWorkflowId: null,
          }),
        };
        const history = {
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue(
            durations?.map((seconds) => ({ seconds: String(seconds) })),
          ),
        };
        mockJobHistoryRepository.createQueryBuilder.mockImplementation(
          (alias: string) => (alias === 'history' ? history : authorization),
        );
        mockJobRepository.count.mockResolvedValueOnce(active);
        mockJobRepository.getRawMany.mockResolvedValue([]);
        mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });

        const result = await service.getJobHistoryDetail(
          mockWorkspaceId,
          mockHistoryId,
        );

        expect(result.etaSeconds).toBe(expected);
        if (durations) {
          expect(history.andWhere).toHaveBeenCalledWith(
            'workflow.workspaceId = :workspaceId',
            { workspaceId: mockWorkspaceId },
          );
          expect(history.limit).toHaveBeenCalledWith(20);
        } else {
          expect(history.getRawMany).not.toHaveBeenCalled();
        }
      },
    );

    const retryAssetId = '178e4123-e64b-4f81-ad3c-8c76eaa83b03';
    const targetScope = { targetIds: [retryAssetId] };
    const projectScope = { assetIds: [retryAssetId] };
    const projectProvenance = {
      projectId: '278e4123-e64b-4f81-ad3c-8c76eaa83b03',
      projectWorkflowId: '378e4123-e64b-4f81-ad3c-8c76eaa83b03',
    };

    it.each([
      {
        label: 'closed target run for a job writer',
        message: 'Tool exited with code 1',
        scope: targetScope,
        permissions: ['job.write'],
        retryAvailable: true,
      },
      {
        label: 'closed run without a recorded scope',
        permissions: ['job.write'],
      },
      {
        label: 'open target run',
        closed: false,
        scope: targetScope,
        permissions: ['job.write'],
      },
      {
        label: 'closed run with active jobs',
        active: 1,
        scope: targetScope,
        permissions: ['job.write'],
      },
      {
        label: 'target run for a read-only viewer',
        scope: targetScope,
        permissions: ['job.read'],
      },
      {
        label: 'project run for a workflow and job writer',
        scope: projectScope,
        provenance: projectProvenance,
        permissions: ['job.write', 'workflow.write'],
        retryAvailable: true,
      },
      {
        label: 'project run for an owner',
        scope: projectScope,
        provenance: projectProvenance,
        permissions: ['*'],
        retryAvailable: true,
      },
      {
        label: 'project run without launch permission',
        scope: projectScope,
        provenance: projectProvenance,
        permissions: ['job.write'],
      },
      {
        label: 'project run with incomplete provenance',
        scope: projectScope,
        provenance: { projectId: projectProvenance.projectId },
        permissions: ['job.write', 'workflow.write'],
      },
      {
        label: 'target run with mixed scope',
        scope: { ...targetScope, ...projectScope },
        permissions: ['job.write'],
      },
    ])(
      'returns failure and retry state for $label',
      async ({
        closed = true,
        active = 0,
        message,
        scope,
        provenance,
        permissions = [],
        retryAvailable = false,
      }) => {
        mockJobHistoryRepository.findOne.mockResolvedValue({
          ...mockJobHistory,
          isCompleted: closed,
          scope,
        });
        mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
          innerJoin: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({
            projectId: null,
            projectWorkflowId: null,
            ...provenance,
          }),
        });
        mockJobRepository.count.mockResolvedValueOnce(active);
        mockJobRepository.getRawMany.mockResolvedValue([]);
        mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });
        const logs = {
          innerJoin: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawOne: jest
            .fn()
            .mockResolvedValue(message ? { message } : undefined),
        };
        mockJobErrorLogRepository.createQueryBuilder.mockReturnValue(logs);

        const result = await service.getJobHistoryDetail(
          mockWorkspaceId,
          mockHistoryId,
          permissions,
        );

        expect(result.failureReason).toBe(message ?? null);
        expect(result.retryAvailable).toBe(retryAvailable);
        expect(result).not.toHaveProperty('projectId');
        expect(result).not.toHaveProperty('scope');
        if (closed && active === 0) {
          expect(logs.andWhere).toHaveBeenCalledWith(
            'target.workspaceId = :workspaceId',
            { workspaceId: mockWorkspaceId },
          );
          expect(logs.andWhere).toHaveBeenCalledWith('job.status = :status', {
            status: JobStatus.FAILED,
          });
          expect(logs.limit).toHaveBeenCalledWith(1);
        } else {
          expect(logs.getRawOne).not.toHaveBeenCalled();
        }
      },
    );

    it('should throw NotFoundException when job history not found', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getJobHistoryDetail(mockWorkspaceId, mockHistoryId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when job history not in workspace', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValue(mockJobHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.getJobHistoryDetail(mockWorkspaceId, mockHistoryId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should not crash when job history has no workflow', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValue({
        ...mockJobHistory,
        workflow: null,
      });
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });

      const result = await service.getJobHistoryDetail(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result.workflowName).toBeUndefined();
      expect(result.tools).toEqual([]);
    });
  });


  describe('getJobHistoryWorkflow', () => {
    const mockWorkspaceId = 'workspace-uuid';
    const mockHistoryId = 'history-uuid';
    const mockJobHistory = {
      id: mockHistoryId,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps: {},
      jobHistoryName: 'test-job-history',
      workflow: {
        id: 'workflow-uuid',
        name: 'test-workflow',
        content: {
          name: 'test-workflow',
          jobs: { test_step: { name: 'Test Step', run: 'test-tool' } },
        },
      },
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockJobHistoryRepository.findOne.mockResolvedValue(mockJobHistory);
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          projectId: null,
          projectWorkflowId: null,
        }),
      });
      mockJobRepository.getRawMany.mockResolvedValue([]);
      mockToolsService.getInstalledTools.mockResolvedValue({ data: [] });
    });

    it('should return the workflow definition of the run as stored', async () => {
      // Scrambled on purpose: jsonb returns object keys in its own order.
      mockJobHistory.workflow.content = {
        jobs: { test_step: { name: 'Test Step', run: 'test-tool' } },
        name: 'test-workflow',
      };
      const result = await service.getJobHistoryWorkflow(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result.workflowId).toBe('workflow-uuid');
      expect(result.workflowName).toBe('test-workflow');
      expect(result.content).toEqual(mockJobHistory.workflow.content);
      // Regression: jsonb does not keep key order, so the code view used to
      // print `jobs` before `name` — the opposite of every workflow template.
      expect(Object.keys(result.content!)).toEqual(['name', 'jobs']);
    });

    it('should keep each job category in the stored definition', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValueOnce({
        ...mockJobHistory,
        workflow: {
          ...mockJobHistory.workflow,
          content: {
            name: 'test-workflow',
            jobs: {
              ports: { run: 'nmap', category: 'ports_scanner' },
              vulns: { run: 'nmap', category: 'vulnerabilities', needs: ['ports'] },
            },
          },
        },
      });

      const result = await service.getJobHistoryWorkflow(mockWorkspaceId, mockHistoryId);

      expect(result.content!.jobs).toEqual({
        ports: { run: 'nmap', category: 'ports_scanner' },
        vulns: { run: 'nmap', category: 'vulnerabilities', needs: ['ports'] },
      });
    });

    it('should count the jobs a worker is executing per step (tool + category)', async () => {
      mockJobHistoryRepository.findOne.mockResolvedValueOnce({
        ...mockJobHistory,
        steps: {
          ports: { status: 'dispatched', jobs: 3 },
          vulns: { status: 'dispatched', jobs: 2 },
        },
        workflow: {
          ...mockJobHistory.workflow,
          content: {
            name: 'test-workflow',
            jobs: {
              ports: { run: 'nmap', category: 'ports_scanner' },
              vulns: { run: 'nmap', category: 'vulnerabilities' },
            },
          },
        },
      });
      mockToolsService.getInstalledTools.mockResolvedValue({
        data: [
          {
            id: 'tool-nmap',
            name: 'nmap',
            categories: [
              { name: ToolCategory.PORTS_SCANNER, targetTypes: HOST },
              { name: ToolCategory.VULNERABILITIES, targetTypes: HOST },
            ],
          },
        ],
      });
      mockJobRepository.getRawMany
        // Tool badge statuses.
        .mockResolvedValueOnce([])
        // In-progress jobs per step: the same tool in two categories stays apart.
        .mockResolvedValueOnce([
          { toolId: 'tool-nmap', category: 'ports_scanner', running: '2' },
          { toolId: 'tool-nmap', category: 'vulnerabilities', running: '0' },
        ]);

      const result = await service.getJobHistoryWorkflow(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result.steps).toEqual([
        expect.objectContaining({ id: 'ports', status: 'dispatched', running: 2 }),
        // Dispatched but not picked up by a worker yet: no running count.
        expect.objectContaining({ id: 'vulns', status: 'dispatched' }),
      ]);
      expect(result.steps[1].running).toBeUndefined();
    });

    it('should include the run steps so the page can show state next to the definition', async () => {
      const result = await service.getJobHistoryWorkflow(
        mockWorkspaceId,
        mockHistoryId,
      );

      expect(result.steps).toEqual([
        expect.objectContaining({ id: 'test_step', run: 'test-tool' }),
      ]);
    });

    it('should throw NotFoundException when the run is not in the workspace', async () => {
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(undefined),
      });

      await expect(
        service.getJobHistoryWorkflow(mockWorkspaceId, mockHistoryId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getJobsTimeline', () => {
    // Two categories of one tool on one target in one run (e.g. nmap ports,
    // then nmap vulnerabilities) are separate steps and must stay separate bars.
    it('starts a new group when the job category changes and groups by it', async () => {
      const query = jest.fn().mockResolvedValue([]);
      (mockDataSource as Record<string, unknown>).query = query;

      await service.getJobsTimeline('ws-1');

      const sql = (query.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain(
        'lag(jobs.category) over (partition by jobs."jobHistoryId" order by jobs."createdAt" desc) = jobs.category',
      );
      expect(sql).toContain('group by grp_id, name, tool_category, target, target_id, "jobHistoryId"');
    });
  });

  describe('getManyJobs', () => {
    const mockWorkspaceId = 'workspace-uuid';

    beforeEach(() => {
      jest.clearAllMocks();
      mockJobRepository.getManyAndCount = jest
        .fn()
        .mockResolvedValue([[], 0]);
    });

    it('should scope jobs to the workspace using param binding', async () => {
      const result = await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(mockJobRepository.andWhere).toHaveBeenCalledWith(
        'target.workspaceId = :workspaceId',
        { workspaceId: mockWorkspaceId },
      );
      expect(mockJobRepository.getManyAndCount).toHaveBeenCalled();
      expect(result).toMatchObject({
        data: [],
        total: 0,
        page: 1,
        limit: 10,
      });
    });

    it('should apply the jobStatus filter when a concrete status is given', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobStatus: JobStatus.FAILED,
      } as any);

      expect(mockJobRepository.andWhere).toHaveBeenCalledWith(
        'job.status = :jobStatus',
        { jobStatus: JobStatus.FAILED },
      );
    });

    it('should skip the status filter when jobStatus is "all"', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobStatus: 'all',
      } as any);

      const statusFilters = mockJobRepository.andWhere.mock.calls.filter(
        ([clause]) =>
          typeof clause === 'string' && clause.includes('job.status'),
      );
      expect(statusFilters).toHaveLength(0);
    });

    it('should fall back to createdAt and append an id tiebreaker for unknown sortBy', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: '__proto__',
        sortOrder: 'ASC',
      } as any);

      expect(mockJobRepository.orderBy).toHaveBeenCalledWith(
        'job.createdAt',
        'ASC',
      );
      expect(mockJobRepository.addOrderBy).toHaveBeenCalledWith('job.id', 'ASC');
    });

    it('should pass through whitelisted sortBy values', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'status',
        sortOrder: 'DESC',
      } as any);

      expect(mockJobRepository.orderBy).toHaveBeenCalledWith(
        'job.status',
        'DESC',
      );
    });

    it('should paginate using take/skip', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 3,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(mockJobRepository.take).toHaveBeenCalledWith(10);
      expect(mockJobRepository.skip).toHaveBeenCalledWith(20);
    });

    it('should hydrate only slim tool columns (id, name, logoUrl) to save bandwidth', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(mockJobRepository.leftJoin).toHaveBeenCalledWith(
        'job.tool',
        'tool',
      );
      expect(mockJobRepository.addSelect).toHaveBeenCalledWith([
        'tool.id',
        'tool.name',
        'tool.logoUrl',
      ]);
      // The full tool entity must no longer be selected eagerly
      const fullToolSelects = mockJobRepository.leftJoinAndSelect.mock.calls
        .filter(([relation]) => relation === 'job.tool');
      expect(fullToolSelects).toHaveLength(0);
    });

    it('should hydrate only slim asset columns (id, value, targetId) to save bandwidth', async () => {
      await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(mockJobRepository.leftJoin).toHaveBeenCalledWith(
        'job.asset',
        'asset',
      );
      expect(mockJobRepository.addSelect).toHaveBeenCalledWith([
        'asset.id',
        'asset.value',
        'asset.targetId',
      ]);
      // The full asset entity must no longer be selected eagerly
      const fullAssetSelects = mockJobRepository.leftJoinAndSelect.mock.calls
        .filter(([relation]) => relation === 'job.asset');
      expect(fullAssetSelects).toHaveLength(0);
      // The target join must remain: it backs the tenant workspaceId filter
      expect(mockJobRepository.leftJoin).toHaveBeenCalledWith(
        'asset.target',
        'target',
      );
      // Target columns must not be selected either (bandwidth)
      expect(mockJobRepository.leftJoinAndSelect).not.toHaveBeenCalledWith(
        'asset.target',
        'target',
      );
    });

    it('should mask secrets in the returned job config', async () => {
      mockJobRepository.getManyAndCount.mockResolvedValue([
        [
          {
            id: 'job-1',
            tool: { name: 'acunetix' },
            config: {
              url: 'https://acunetix.local',
              apiKey: 'super-secret-key',
            },
          },
        ],
        1,
      ]);
      mockConnectorRegistryService.getConnector.mockReturnValue({
        configSchema: {
          properties: { apiKey: { type: 'string', 'ui:widget': 'password' } },
        },
      });

      const result = await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(result.data[0].config).toEqual({
        url: 'https://acunetix.local',
        apiKey: '****-key',
      });
    });

    it('should still mask secret-named config keys when no connector schema resolves', async () => {
      mockJobRepository.getManyAndCount.mockResolvedValue([
        [
          {
            id: 'job-2',
            tool: { name: 'unknown-connector' },
            config: { url: 'https://x.local', password: 'hunter2' },
          },
        ],
        1,
      ]);
      mockConnectorRegistryService.getConnector.mockReturnValue(null);

      const result = await service.getManyJobs(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(result.data[0].config).toEqual({
        url: 'https://x.local',
        password: '****ter2',
      });
    });
  });

  describe('getManyJobHistories', () => {
    const mockWorkspaceId = 'workspace-uuid';

    interface HistoryQueryBuilder {
      innerJoin: jest.Mock<HistoryQueryBuilder>;
      leftJoin: jest.Mock<HistoryQueryBuilder>;
      where: jest.Mock<HistoryQueryBuilder>;
      andWhere: jest.Mock<HistoryQueryBuilder>;
      select: (args: unknown[]) => HistoryQueryBuilder;
      groupBy: jest.Mock<HistoryQueryBuilder>;
      addGroupBy: jest.Mock<HistoryQueryBuilder>;
      having: jest.Mock<HistoryQueryBuilder>;
      orderBy: jest.Mock<HistoryQueryBuilder>;
      addOrderBy: jest.Mock<HistoryQueryBuilder>;
      offset: jest.Mock<HistoryQueryBuilder>;
      limit: jest.Mock<HistoryQueryBuilder>;
      getRawMany: jest.Mock<Promise<unknown[]>>;
      getCount: jest.Mock<Promise<number>>;
    }

    const buildHistoryQueryBuilder = () => {
      const selectArgs: unknown[][] = [];
      const qb: HistoryQueryBuilder = {
        innerJoin: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn((args: unknown[]) => {
          selectArgs.push(args);
          return qb;
        }),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        having: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        offset: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
      };
      return { qb, selectArgs };
    };

    /**
     * The method builds a SINGLE query builder. `total` used to require a
     * second, distinct-id aggregate pass; it now rides on the paged select as a
     * `COUNT(*) OVER ()` window, so tests drive one builder and the row count
     * arrives in the same rows.
     */
    const stubHistoryQueryBuilder = () => {
      const paged = buildHistoryQueryBuilder();
      mockJobHistoryRepository.createQueryBuilder.mockReset();
      mockJobHistoryRepository.createQueryBuilder.mockReturnValue(paged.qb);
      return { paged };
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should compute totalJobs and status from joined jobs without correlated subqueries', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb, selectArgs } = paged;
      qb.getRawMany.mockResolvedValue([
        {
          id: 'history-1',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-02T00:00:00Z'),
          totalJobs: '4',
          completedJobs: '1',
          failedJobs: '1',
          cancelledJobs: '0',
          status: JobStatus.IN_PROGRESS,
          workflowName: 'workflow-1',
          jobHistoryName: 'run-1',
          jobRunType: JobRunType.MANUAL,
          total: '2',
        },
      ]);

      const result = await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(selectArgs[0]).toContain('COUNT(job.id) as "totalJobs"');
      // No correlated subquery referencing the jobs table from scratch
      expect(
        selectArgs[0].some(
          (s) => typeof s === 'string' && s.includes('FROM jobs'),
        ),
      ).toBe(false);
      // Status derived from the joined job rows via aggregate FILTER
      const statusExpr = selectArgs[0].find(
        (s) => typeof s === 'string' && s.includes('FILTER'),
      ) as string;
      expect(statusExpr).toContain(`job.status = '${JobStatus.FAILED}'`);
      expect(statusExpr).toContain(`job.status = '${JobStatus.IN_PROGRESS}'`);
      expect(selectArgs[0]).toContain('COUNT(*) OVER () as "total"');
      for (const [status, alias] of [
        [JobStatus.COMPLETED, 'completedJobs'],
        [JobStatus.FAILED, 'failedJobs'],
        [JobStatus.CANCELLED, 'cancelledJobs'],
      ]) {
        expect(selectArgs[0]).toContain(
          `COUNT(*) FILTER (WHERE job.status = '${status}') as "${alias}"`,
        );
      }
      // One query serves both the page and its total
      expect(mockJobHistoryRepository.createQueryBuilder).toHaveBeenCalledTimes(
        1,
      );
      expect(result.total).toBe(2);
    });

    it('should aggregate terminal cancelled status when all jobs are cancelled', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb, selectArgs } = paged;
      qb.getRawMany.mockResolvedValue([]);

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      const statusExpr = selectArgs[0].find(
        (s) => typeof s === 'string' && s.includes('FILTER'),
      ) as string;
      // All-cancelled histories must surface as cancelled, not pending
      expect(statusExpr).toContain(`THEN '${JobStatus.CANCELLED}'`);
      expect(statusExpr).toContain(
        `job.status = '${JobStatus.CANCELLED}') > 0`,
      );
    });

    it('should surface a cancelled run even when some jobs already completed', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb, selectArgs } = paged;
      qb.getRawMany.mockResolvedValue([]);

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      const statusExpr = selectArgs[0].find(
        (s) => typeof s === 'string' && s.includes('FILTER'),
      ) as string;
      // Derived purely from the child jobs: a cancelled job with nothing left
      // pending/in-progress means the user stopped the run. Without this branch
      // a run cancelled after 30/100 jobs would fall through to "pending".
      expect(statusExpr).toContain(
        `WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.CANCELLED}') > 0`,
      );
      expect(statusExpr).toContain(
        `COUNT(*) FILTER (WHERE job.status IN ('${JobStatus.PENDING}', '${JobStatus.IN_PROGRESS}')) = 0`,
      );
      expect(statusExpr.indexOf(JobStatus.CANCELLED)).toBeLessThan(
        statusExpr.indexOf(JobStatus.FAILED),
      );
    });

    it('should aggregate terminal skipped status when all jobs are skipped', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb, selectArgs } = paged;
      qb.getRawMany.mockResolvedValue([]);

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      const statusExpr = selectArgs[0].find(
        (s) => typeof s === 'string' && s.includes('FILTER'),
      ) as string;
      // All-skipped histories must surface as skipped, not pending
      expect(statusExpr).toContain(
        `WHEN COUNT(*) FILTER (WHERE job.status = '${JobStatus.SKIPPED}') = COUNT(*) AND COUNT(*) > 0 THEN '${JobStatus.SKIPPED}'`,
      );
    });

    it('should fall back to createdAt and append an id tiebreaker for unknown sortBy', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb } = paged;

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: '__proto__',
        sortOrder: 'ASC',
      } as any);

      expect(qb.orderBy).toHaveBeenCalledWith('jobHistory.createdAt', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('jobHistory.id', 'ASC');
    });

    it('should pass through whitelisted sortBy values', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb } = paged;

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'jobHistoryName',
        sortOrder: 'DESC',
      } as any);

      expect(qb.orderBy).toHaveBeenCalledWith(
        'jobHistory.jobHistoryName',
        'DESC',
      );
    });

    it('should transform raw rows into the response DTO shape', async () => {
      const { paged } = stubHistoryQueryBuilder();
      const { qb } = paged;
      qb.getRawMany.mockResolvedValue([
        {
          id: 'history-1',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-02T00:00:00Z'),
          totalJobs: '5',
          completedJobs: '2',
          failedJobs: '1',
          cancelledJobs: '1',
          status: JobStatus.IN_PROGRESS,
          workflowName: 'workflow-1',
          jobHistoryName: 'name-1',
          jobRunType: 'manual',
        },
      ]);

      const result = await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as any);

      expect(result.data[0]).toEqual({
        id: 'history-1',
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        totalJobs: 5,
        completedJobs: 2,
        failedJobs: 1,
        progress: 80,
        status: JobStatus.IN_PROGRESS,
        workflowName: 'workflow-1',
        jobHistoryName: 'name-1',
        jobRunType: 'manual',
      });
    });

    it.each([
      {
        totalJobs: 3,
        completedJobs: 0,
        failedJobs: 0,
        cancelledJobs: 3,
        progress: 100,
      },
      {
        totalJobs: 1000,
        completedJobs: 999,
        failedJobs: 0,
        cancelledJobs: 0,
        progress: 99,
      },
      {
        totalJobs: 3,
        completedJobs: 0,
        failedJobs: 0,
        cancelledJobs: 0,
        progress: 0,
      },
    ])(
      'keeps the run-list completion boundary at $progress%',
      async ({ totalJobs, completedJobs, failedJobs, cancelledJobs, progress }) => {
        const { paged } = stubHistoryQueryBuilder();
        paged.qb.getRawMany.mockResolvedValue([
          {
            id: 'history-1',
            totalJobs: String(totalJobs),
            completedJobs: String(completedJobs),
            failedJobs: String(failedJobs),
            cancelledJobs: String(cancelledJobs),
            total: '1',
          },
        ]);

        const result = await service.getManyJobHistories(mockWorkspaceId, {
          page: 1,
          limit: 10,
        });

        expect(result.data[0]).toMatchObject({
          completedJobs,
          failedJobs,
          progress,
        });
      },
    );

    it('should apply the search predicate to the page query', async () => {
      const { paged } = stubHistoryQueryBuilder();

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        search: 'nightly',
      } as any);

      expect(paged.qb.andWhere).toHaveBeenCalledWith(
        '(jobHistory.jobHistoryName ILIKE :search OR workflow.name ILIKE :search)',
        { search: '%nightly%' },
      );
    });

    it('should filter on the status rollup via HAVING, and skip it for "all"', async () => {
      const filtered = stubHistoryQueryBuilder();

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobStatus: JobStatus.FAILED,
      } as any);

      const [havingSql, havingParams] = filtered.paged.qb.having.mock.calls[0] as [
        string,
        { jobStatus: string },
      ];
      expect(havingSql).toContain('FILTER');
      expect(havingParams).toEqual({ jobStatus: JobStatus.FAILED });

      const unfiltered = stubHistoryQueryBuilder();
      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobStatus: 'all',
      } as any);
      expect(unfiltered.paged.qb.having).not.toHaveBeenCalled();
    });

    it('should filter by run type and a creation-date range on the page query', async () => {
      const { paged } = stubHistoryQueryBuilder();

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobRunType: JobRunType.SCHEDULED,
        createdFrom: '2026-01-01',
        createdTo: '2026-01-31',
      } as any);

      const ranged = (qb: typeof paged.qb) => {
        expect(qb.andWhere).toHaveBeenCalledWith(
          'jobHistory.jobRunType = :jobRunType',
          { jobRunType: JobRunType.SCHEDULED },
        );
        expect(qb.andWhere).toHaveBeenCalledWith(
          'jobHistory.createdAt >= :createdFrom',
          { createdFrom: new Date('2026-01-01') },
        );
        const [, params] = qb.andWhere.mock.calls.find(
          ([sql]) => sql === 'jobHistory.createdAt <= :createdTo',
        ) as [string, { createdTo: Date }];
        // A bare date means "through the end of that day".
        expect(params.createdTo.getHours()).toBe(23);
        expect(params.createdTo.getMilliseconds()).toBe(999);
      };

      ranged(paged.qb);
    });

    it('should skip run type and date filters for "all" / absent values', async () => {
      const { paged } = stubHistoryQueryBuilder();

      await service.getManyJobHistories(mockWorkspaceId, {
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
        jobRunType: 'all',
      } as any);

      expect(paged.qb.andWhere).not.toHaveBeenCalled();
    });
  });

  // ── SCREENSHOT live asset-service filter ─────────────────────────────

  describe('createNewJob — SCREENSHOT live asset-service filter', () => {
    const mockJobRepo = {
      create: jest
        .fn()
        .mockImplementation((partial: Record<string, unknown>) => ({
          id: 'job-uuid',
          ...partial,
        })),
      save: jest
        .fn()
        .mockImplementation((jobs: unknown) => Promise.resolve(jobs)),
    };

    let mockAssetServiceQB: Record<string, jest.Mock>;
    let scopeLoad: ReturnType<typeof mockServiceScope>;

    const screenshotTool = {
      id: 'tool-ss',
      name: 'screenshot',
      categories: [{ name: ToolCategory.SCREENSHOT, targetTypes: HOST }],
      priority: 4,
    } as any;

    const httpProbeTool = {
      id: 'tool-hp',
      name: 'httpx',
      categories: [{ name: ToolCategory.HTTP_PROBE, targetTypes: HOST }],
      priority: 4,
    } as any;

    const makeService = (id: string) => ({
      id,
      value: `${id}.example.com`,
      port: 443,
      asset: { id: `asset-${id}`, isPrimary: true, value: `${id}.example.com` },
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockJobHistoryRepository.create = jest
        .fn()
        .mockReturnValue({ id: 'jh-1' });
      mockJobHistoryRepository.save = jest
        .fn()
        .mockResolvedValue({ id: 'jh-1' });
      mockConnectorRegistryService.getConnector.mockReturnValue(null);

      mockAssetServiceQB = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      const mockAssetServiceRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(mockAssetServiceQB),
      };
      scopeLoad = mockServiceScope(async () => mockAssetServiceQB.getMany() as Promise<AssetService[]>);
      mockDataSource.getRepository.mockImplementation((entity: any) => {
        const name = entity?.name ?? entity;
        if (name === 'AssetService') return mockAssetServiceRepo;
        return mockJobRepo;
      });
    });

    afterEach(() => scopeLoad.mockRestore());

    it('SCREENSHOT: requests live web services and creates one job per live service', async () => {
      const liveServices = [makeService('as-1'), makeService('as-2')];
      mockAssetServiceQB.getMany.mockResolvedValue(liveServices);

      const result = await service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(scopeLoad).toHaveBeenCalledWith([DataKind.WEB], expect.objectContaining({
        targetIds: ['target-1'], workspaceId: 'ws-1', targetTypes: HOST,
      }));

      expect(result).toHaveLength(2);
      expect(mockWorkerStreamRegistry.publishJobsAvailable).toHaveBeenCalledTimes(1);
      expect(mockWorkerStreamRegistry.publishJobsAvailable).toHaveBeenCalledWith('ws-1');
      expect(mockJobRepo.save.mock.invocationCallOrder[0]).toBeLessThan(
        mockWorkerStreamRegistry.publishJobsAvailable.mock.invocationCallOrder[0],
      );
      expect(mockJobRepo.save).toHaveBeenCalledTimes(1);
      expect(mockJobRepo.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ category: ToolCategory.SCREENSHOT }),
        ]),
      );
    });

    it('does not publish a hint when job persistence fails', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([makeService('as-1')]);
      mockJobRepo.save.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      })).rejects.toThrow('database unavailable');
      expect(mockWorkerStreamRegistry.publishJobsAvailable).not.toHaveBeenCalled();
    });

    it('SCREENSHOT edge (empty): no live services => 0 jobs inserted, no throw', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([]);

      const result = await service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(result).toHaveLength(0);
      expect(mockJobRepo.save).not.toHaveBeenCalled();
      expect(mockWorkerStreamRegistry.publishJobsAvailable).not.toHaveBeenCalled();
    });

    it('SCREENSHOT edge (dedup): web scope yields one job per live service', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([makeService('as-1')]);

      const result = await service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(scopeLoad).toHaveBeenCalledWith([DataKind.WEB], expect.anything());
      expect(mockAssetServiceQB.distinct).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('HTTP_PROBE regression: no live filter applied; every service still produces a job', async () => {
      const allServices = [
        makeService('as-1'),
        makeService('as-2'),
        makeService('as-3'),
      ];
      mockAssetServiceQB.getMany.mockResolvedValue(allServices);

      const result = await service.createNewJob({
        tool: httpProbeTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(scopeLoad).toHaveBeenCalledWith([DataKind.SERVICE], expect.anything());
      expect(mockAssetServiceQB.distinct).not.toHaveBeenCalled();
      expect(result).toHaveLength(3);
    });
  });

  // ── url_discovery routing ────────────────────────────────────────────

  describe('createNewJob — category routing', () => {
    const mockJobRepo = {
      create: jest
        .fn()
        .mockImplementation((partial: Record<string, unknown>) => ({
          id: 'job-uuid',
          ...partial,
        })),
      save: jest
        .fn()
        .mockImplementation((jobs: unknown) => Promise.resolve(jobs)),
    };

    let mockAssetServiceQB: Record<string, jest.Mock>;
    let scopeLoad: ReturnType<typeof mockServiceScope>;
    let mockAssetQB: Record<string, jest.Mock>;

    const urlDiscoveryTool = {
      id: 'tool-ud',
      name: 'katana',
      categories: [{ name: ToolCategory.URL_DISCOVERY, targetTypes: HOST }],
      priority: 4,
    } as any;

    const screenshotTool = {
      id: 'tool-ss',
      name: 'screenshot',
      categories: [{ name: ToolCategory.SCREENSHOT, targetTypes: HOST }],
      priority: 4,
    } as any;

    const httpProbeTool = {
      id: 'tool-hp',
      name: 'httpx',
      categories: [{ name: ToolCategory.HTTP_PROBE, targetTypes: HOST }],
      priority: 4,
    } as any;

    const subdomainsTool = {
      id: 'tool-sub',
      name: 'subfinder',
      categories: [{ name: ToolCategory.SUBDOMAINS, targetTypes: HOST }],
      priority: 4,
    } as any;

    const portsScannerTool = {
      id: 'tool-ports',
      name: 'naabu',
      categories: [{ name: ToolCategory.PORTS_SCANNER, targetTypes: HOST }],
      priority: 3,
    } as any;

    const makeService = (id: string) => ({
      id,
      value: `${id}.example.com`,
      port: 443,
      asset: { id: `asset-${id}`, isPrimary: true, value: `${id}.example.com` },
    });

    afterEach(() => scopeLoad.mockRestore());

    beforeEach(() => {
      jest.clearAllMocks();
      mockJobHistoryRepository.create = jest
        .fn()
        .mockReturnValue({ id: 'jh-1' });
      mockJobHistoryRepository.save = jest
        .fn()
        .mockResolvedValue({ id: 'jh-1' });
      mockConnectorRegistryService.getConnector.mockReturnValue(null);

      mockAssetServiceQB = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      mockAssetQB = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      scopeLoad = mockServiceScope(async () => mockAssetServiceQB.getMany() as Promise<AssetService[]>);
      mockDataSource.getRepository.mockImplementation((entity: any) => {
        const name = entity?.name ?? entity;
        if (name === 'AssetService') {
          return { createQueryBuilder: jest.fn().mockReturnValue(mockAssetServiceQB) };
        }
        if (name === 'Asset') {
          return { createQueryBuilder: jest.fn().mockReturnValue(mockAssetQB) };
        }
        return mockJobRepo;
      });
    });

    it('S1: URL_DISCOVERY finds asset services (not assets) and creates one job per service with assetService + jobHistory', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([
        makeService('as-1'),
        makeService('as-2'),
      ]);

      const result = await service.createNewJob({
        tool: urlDiscoveryTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(result).toHaveLength(2);
      expect(mockAssetServiceQB.getMany).toHaveBeenCalled();
      expect(mockAssetQB.getMany).not.toHaveBeenCalled();
      for (const job of result) {
        expect((job as any).assetService).toBeDefined();
        expect((job as any).jobHistory).toBeDefined();
        expect((job as any).category).toBe(ToolCategory.URL_DISCOVERY);
      }
    });

    it('S1b: URL_DISCOVERY plans every live web service of each asset', async () => {
      const assetA = { id: 'asset-a', isPrimary: true, value: 'a.example.com' };
      const assetB = { id: 'asset-b', isPrimary: false, value: 'b.example.com' };
      mockAssetServiceQB.getMany.mockResolvedValue([
        { id: 'a-8080', value: 'a.example.com', port: 8080, asset: assetA },
        { id: 'a-80', value: 'a.example.com', port: 80, asset: assetA },
        { id: 'a-443', value: 'a.example.com', port: 443, asset: assetA },
        { id: 'b-8443', value: 'b.example.com', port: 8443, asset: assetB },
        { id: 'b-80', value: 'b.example.com', port: 80, asset: assetB },
      ]);

      const result = await service.createNewJob({
        tool: urlDiscoveryTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      const serviceIds = result.map(
        (job) => (job as unknown as { assetService: { id: string } }).assetService.id,
      );
      expect(serviceIds.sort()).toEqual([
        'a-443',
        'a-80',
        'a-8080',
        'b-80',
        'b-8443',
      ]);
    });

    it('S1c regression: SCREENSHOT still creates one job per live service', async () => {
      const asset = { id: 'asset-a', isPrimary: true, value: 'a.example.com' };
      mockAssetServiceQB.getMany.mockResolvedValue([
        { id: 'a-80', value: 'a.example.com', port: 80, asset },
        { id: 'a-443', value: 'a.example.com', port: 443, asset },
      ]);

      const result = await service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(result).toHaveLength(2);
    });

    it('S2 edge: URL_DISCOVERY requests the live web scope', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([makeService('as-1')]);

      await service.createNewJob({
        tool: urlDiscoveryTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(scopeLoad).toHaveBeenCalledWith([DataKind.WEB], expect.anything());
    });

    it('S3 regression: SUBDOMAINS uses findAssetsForJob, not asset services', async () => {
      mockAssetQB.getMany.mockResolvedValue([
        { id: 'asset-1', value: 'example.com', isPrimary: true, target: { type: TargetType.DOMAIN } },
      ]);

      const result = await service.createNewJob({
        tool: subdomainsTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(mockAssetQB.getMany).toHaveBeenCalled();
      expect(mockAssetServiceQB.getMany).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('PORTS_SCANNER keeps the explicit asset scope supplied by a group workflow', async () => {
      const selectedAssetIds = ['group-asset-1', 'group-asset-2'];
      mockAssetQB.getMany.mockResolvedValue([
        {
          id: 'group-asset-1',
          value: 'one.example.com',
          isPrimary: true,
          target: { type: TargetType.DOMAIN },
        },
        {
          id: 'group-asset-2',
          value: 'two.example.com',
          isPrimary: true,
          target: { type: TargetType.DOMAIN },
        },
      ]);

      const result = await service.createNewJob({
        tool: portsScannerTool,
        assetIds: selectedAssetIds,
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });

      expect(mockAssetQB.andWhere).toHaveBeenCalledWith(
        'assets.id = ANY(:assetIds)',
        { assetIds: selectedAssetIds },
      );
      expect(mockAssetQB.andWhere).not.toHaveBeenCalledWith(
        'assets.targetId = ANY(:targetIds)',
        expect.anything(),
      );
      expect(result.map((job) => job.asset.id)).toEqual(selectedAssetIds);
    });

    describe('category selection', () => {
      const nmap = {
        id: 'tool-nmap',
        name: 'nmap',
        priority: 4,
        categories: [
          { name: ToolCategory.PORTS_SCANNER, targetTypes: [TargetType.DOMAIN, TargetType.IP] },
          { name: ToolCategory.HTTP_PROBE, targetTypes: [TargetType.DOMAIN] },
        ],
      } as any;

      it('defaults job.category and target types to the tool first category', async () => {
        mockAssetQB.getMany.mockResolvedValue([{ id: 'a-1', value: 'example.com', isPrimary: true, target: { type: TargetType.DOMAIN } }]);

        const jobs = await service.createNewJob({
          tool: nmap,
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        expect(jobs.map((j) => j.category)).toEqual([ToolCategory.PORTS_SCANNER]);
        expect(mockAssetQB.andWhere).toHaveBeenCalledWith('target.type IN (:...targetTypes)', {
          targetTypes: [TargetType.DOMAIN, TargetType.IP],
        });
      });

      it('uses the requested category for asset source and target types', async () => {
        mockAssetServiceQB.getMany.mockResolvedValue([makeService('as-1')]);

        const jobs = await service.createNewJob({
          tool: nmap,
          category: ToolCategory.HTTP_PROBE,
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        expect(jobs.map((j) => j.category)).toEqual([ToolCategory.HTTP_PROBE]);
        expect(scopeLoad).toHaveBeenCalledWith([DataKind.SERVICE], expect.objectContaining({
          targetTypes: [TargetType.DOMAIN],
        }));
        expect(mockAssetQB.getMany).not.toHaveBeenCalled();
      });

      it('rejects a category the tool does not declare', async () => {
        await expect(
          service.createNewJob({
            tool: nmap,
            category: ToolCategory.SCREENSHOT,
            workspaceId: 'ws-1',
            workflow: { id: 'wf-1' } as any,
          }),
        ).rejects.toThrow('Tool "nmap" has no category "screenshot"');
      });
    });

    describe('target type filter', () => {
      it('restricts assets to the target types the tool declares', async () => {
        await service.createNewJob({
          tool: { ...subdomainsTool, categories: [{ name: ToolCategory.SUBDOMAINS, targetTypes: [TargetType.DOMAIN] }] },
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        expect(mockAssetQB.innerJoinAndSelect).toHaveBeenCalledWith(
          'assets.target',
          'target',
        );
        expect(mockAssetQB.andWhere).toHaveBeenCalledWith(
          'target.type IN (:...targetTypes)',
          { targetTypes: [TargetType.DOMAIN] },
        );
      });

      it('treats a category without declared target types as a host scanner', async () => {
        await service.createNewJob({
          tool: { ...portsScannerTool, categories: [{ name: ToolCategory.PORTS_SCANNER, targetTypes: [] }] },
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        expect(mockAssetQB.andWhere).toHaveBeenCalledWith(
          'target.type IN (:...targetTypes)',
          {
            targetTypes: [TargetType.DOMAIN, TargetType.IP, TargetType.CIDR],
          },
        );
      });

      it('restricts asset services the same way', async () => {
        await service.createNewJob({
          tool: { ...httpProbeTool, categories: [{ name: ToolCategory.HTTP_PROBE, targetTypes: [TargetType.IP] }] },
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        expect(scopeLoad).toHaveBeenCalledWith([DataKind.SERVICE], expect.objectContaining({
          targetTypes: [TargetType.IP],
        }));
      });

      it('creates no job when no asset of a supported type is in scope', async () => {
        mockAssetQB.getMany.mockResolvedValue([]);

        const result = await service.createNewJob({
          tool: { ...subdomainsTool, categories: [{ name: ToolCategory.SUBDOMAINS, targetTypes: [TargetType.DOMAIN] }] },
          targetIds: ['ip-target'],
          workspaceId: 'ws-1',
          workflow: { id: 'wf-1' } as any,
        });

        // The workflow runner marks a zero-job step as skipped ('no-inputs').
        expect(result).toEqual([]);
      });
    });

    it('S3 regression: SCREENSHOT uses asset services with liveOnly=true; HTTP_PROBE with liveOnly=false', async () => {
      mockAssetServiceQB.getMany.mockResolvedValue([makeService('as-1')]);

      await service.createNewJob({
        tool: screenshotTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });
      expect(scopeLoad).toHaveBeenCalledWith([DataKind.WEB], expect.anything());

      jest.clearAllMocks();
      mockJobHistoryRepository.create = jest.fn().mockReturnValue({ id: 'jh-1' });
      mockJobHistoryRepository.save = jest.fn().mockResolvedValue({ id: 'jh-1' });
      mockConnectorRegistryService.getConnector.mockReturnValue(null);
      mockAssetServiceQB = {
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        distinct: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([makeService('as-1')]),
      };
      mockDataSource.getRepository.mockImplementation((entity: any) => {
        const name = entity?.name ?? entity;
        if (name === 'AssetService') {
          return { createQueryBuilder: jest.fn().mockReturnValue(mockAssetServiceQB) };
        }
        return mockJobRepo;
      });

      await service.createNewJob({
        tool: httpProbeTool,
        targetIds: ['target-1'],
        workspaceId: 'ws-1',
        workflow: { id: 'wf-1' } as any,
      });
      expect(scopeLoad).toHaveBeenCalledWith([DataKind.SERVICE], expect.anything());
    });
  });

  describe('getNextJobs — batched claim', () => {
    const buildWorker = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id: 'worker-uuid',
      type: WorkerType.BUILT_IN,
      scope: WorkerScope.CLOUD,
      runMode: 'node',
      internalNetworkId: null,
      workspace: { id: 'workspace-uuid' },
      tool: null,
      ...overrides,
    });

    const buildQueryRunner = (jobs: unknown[]) => {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities: jobs, raw: [] }),
      };

      const queryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        manager: {
          createQueryBuilder: jest.fn().mockReturnValue(qb),
          update: jest.fn().mockResolvedValue({ affected: jobs.length }),
        },
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
      };

      return { qb, queryRunner };
    };

    const givenWorkerAndQueue = (worker: unknown, jobs: unknown[]) => {
      const { qb, queryRunner } = buildQueryRunner(jobs);
      mockDataSource.getRepository.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(worker),
      } as any);
      mockDataSource.createQueryRunner.mockReturnValue(queryRunner as any);
      return { qb, queryRunner };
    };

    beforeEach(() => {
      mockConnectorRegistryService.getAllConnectors.mockReturnValue([]);
    });

    it('claims up to `limit` jobs in one query and one update', async () => {
      // Given: three pending jobs and a worker with three free slots
      const jobs = [
        { id: 'job-1', asset: { id: 'a1', value: 'x' } },
        { id: 'job-2', asset: { id: 'a2', value: 'y' } },
        { id: 'job-3', asset: { id: 'a3', value: 'z' } },
      ];
      const { qb, queryRunner } = givenWorkerAndQueue(buildWorker(), jobs);

      // When
      const result = await service.getNextJobs('worker-uuid', 3);

      // Then: a single claim replaces three per-slot claims
      expect(result).toHaveLength(3);
      expect(mockDataSource.getRepository).toHaveBeenCalledWith(WorkerInstance);
      expect(qb.limit).toHaveBeenCalledWith(3);
      expect(queryRunner.manager.update).toHaveBeenCalledTimes(1);
      const claim = queryRunner.manager.update.mock.calls[0][2];
      expect(claim).toMatchObject({ findingScanScopeKey: null });
      expect(result.every(job => job.claimedAt === claim.pickJobAt)).toBe(true);
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });

    it.each([WorkerType.BUILT_IN, WorkerType.CONNECTOR])(
      'hydrates private input snapshots for %s worker claims',
      async (type) => {
        const inputs = { target: 'https://app.example.com:8443' };
        const tool = { id: 'nuclei-id', name: 'nuclei' };
        const { qb } = givenWorkerAndQueue(buildWorker({ type, tool }), [
          {
            id: 'job-inputs', tool, inputs,
            asset: { value: 'app.example.com', target: { workspaceId: 'ws-1' } },
          },
        ]);
        const [job] = await service.getNextJobs('worker-uuid', 1);
        expect(qb.addSelect).toHaveBeenCalledWith('jobs.inputs');
        expect(job).toMatchObject({ inputs, tool, workspaceId: 'ws-1' });
      },
    );

    it('keys the dispatched scope with the workspace DEK and only updates its current claim', async () => {
      getDEK.mockResolvedValueOnce(Buffer.alloc(32, 1))
        .mockResolvedValueOnce(Buffer.alloc(32, 1))
        .mockResolvedValueOnce(Buffer.alloc(32, 1))
        .mockResolvedValueOnce(Buffer.alloc(32, 2));
      const claimedAt = new Date('2026-11-01T07:30:00.123Z');
      const scanClaimInstant = new Date('2026-11-01T06:30:00.123Z');
      const job = {
        id: 'claimed-job', category: ToolCategory.VULNERABILITIES, workspaceId: 'ws-1',
        claimedAt, scanClaimInstant, asset: { id: 'asset-1', value: '127.0.0.1' },
        tool: { id: 'tool-1', name: 'nuclei' },
      } as GetNextJobResult;
      const target = { target: 'http://127.0.0.1:8080/' };
      const image = 'nuclei:test';
      await service.recordFindingScanScope(job, 'worker-1', image, target, { b: 1, a: { y: 2, x: 3 } });
      await service.recordFindingScanScope(job, 'worker-1', image, target, { a: { x: 3, y: 2 }, b: 1 });
      await service.recordFindingScanScope(job, 'worker-1', image, { target: 'http://127.0.0.1:8081/' }, { a: { x: 3, y: 2 }, b: 1 });
      await service.recordFindingScanScope(job, 'worker-1', image, target, { a: { x: 3, y: 2 }, b: 1 });

      expect(getDEK).toHaveBeenCalledWith('ws-1');
      const keys = mockJobRepository.query.mock.calls.map(([, params]) =>
        (params as [string, string, string, Date, string])[4],
      );
      const [firstKey, same, differentTarget, differentWorkspaceKey] = keys;
      expect(firstKey).toMatch(/^[0-9a-f]{64}$/);
      expect(mockJobRepository.query).toHaveBeenNthCalledWith(
        1,
        expect.stringMatching(/FOR UPDATE SKIP LOCKED[\s\S]*"findingScanClaimedAt" = \$6::timestamptz/),
        [job.id, 'worker-1', JobStatus.IN_PROGRESS, claimedAt, firstKey, '2026-11-01T06:30:00.123Z'],
      );
      expect(same).toBe(firstKey);
      expect(differentTarget).not.toBe(firstKey);
      expect(differentWorkspaceKey).not.toBe(firstKey);
    });

    it('clears coverage on reclaim and advances the claim marker past the prior one', async () => {
      const previous = new Date(Date.now() + 1_000);
      const { queryRunner } = givenWorkerAndQueue(buildWorker(), [
        { id: 'reclaimed-job', asset: { id: 'asset-1' }, pickJobAt: previous },
      ]);

      const [job] = await service.getNextJobs('worker-uuid', 1);

      expect(job.claimedAt).toBeUndefined();
      expect(queryRunner.manager.update.mock.calls[0][2]).toMatchObject({
        pickJobAt: new Date(previous.getTime() + 1),
        findingScanScopeKey: null,
        findingScanClaimedAt: null,
        findingScanCoverageComplete: null,
      });
    });

    it('keeps a fresh claim instant separate from a future marker in a mixed batch', async () => {
      const scanClaimInstant = new Date();
      const future = new Date(scanClaimInstant.getTime() + 60_000);
      const jobs = [
        { id: 'fresh-job', asset: { id: 'asset-1' } },
        { id: 'retried-job', asset: { id: 'asset-2' }, pickJobAt: future },
      ];
      const { qb } = givenWorkerAndQueue(buildWorker(), jobs);
      qb.getRawAndEntities.mockResolvedValue({ entities: jobs, raw: [{ scanClaimInstant }] });

      const [fresh, retry] = await service.getNextJobs('worker-uuid', 2);

      expect(fresh.claimedAt?.getTime()).toBe(future.getTime() + 1);
      expect(fresh.scanClaimInstant).toEqual(scanClaimInstant);
      expect(retry.scanClaimInstant).toBeUndefined();
    });

    it('caps the claim so a worker cannot drain the whole queue', async () => {
      // Given: a worker asking for far more than the server-side ceiling
      const { qb } = givenWorkerAndQueue(buildWorker(), []);

      // When
      await service.getNextJobs('worker-uuid', 100000);

      // Then
      expect(qb.limit).toHaveBeenCalledWith(100);
    });

    it('returns an empty list and rolls back when nothing is claimable', async () => {
      // Given: an idle queue
      const { queryRunner } = givenWorkerAndQueue(buildWorker(), []);

      // When
      const result = await service.getNextJobs('worker-uuid', 5);

      // Then: no work is claimed and nothing is written
      expect(result).toEqual([]);
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it('enforces job eligibility in SQL instead of dropping the whole claim', async () => {
      // Given: a node worker that is allowed to run connectors
      mockConnectorRegistryService.getAllConnectors.mockReturnValue([
        { slug: 'nuclei' },
      ]);
      const { qb } = givenWorkerAndQueue(buildWorker(), []);

      // When
      await service.getNextJobs('worker-uuid', 2);

      // Then: "has a command or belongs to a connector" is a WHERE clause, so a
      // command-less non-connector job at the head of the queue can no longer
      // starve the rest of the batch (the previous post-query filter did).
      const predicates = qb.andWhere.mock.calls.map((call) => String(call[0]));
      expect(
        predicates.some((sql) => sql.includes('jobs.command IS NOT NULL')),
      ).toBe(true);
      expect(predicates.some((sql) => sql.includes('connectorSlugs'))).toBe(
        true,
      );
    });

    it('does not require the connector clause on a cli-mode worker', async () => {
      // Given: a CLI worker that has no Docker and therefore no connector tools
      const { qb } = givenWorkerAndQueue(buildWorker({ runMode: 'cli' }), []);

      // When
      await service.getNextJobs('worker-uuid', 2);

      // Then: only the command check applies
      const predicates = qb.andWhere.mock.calls.map((call) => String(call[0]));
      expect(
        predicates.some((sql) => sql.includes('jobs.command IS NOT NULL')),
      ).toBe(true);
      expect(predicates.some((sql) => sql.includes('connectorSlugs'))).toBe(
        false,
      );
    });

    it('getNextJob delegates to the batched claim', async () => {
      // Given: one claimable job
      const { qb } = givenWorkerAndQueue(buildWorker(), [
        { id: 'job-1', asset: { id: 'a1', value: 'x' } },
      ]);

      // When
      const job = await service.getNextJob('worker-uuid');

      // Then
      expect(job?.id).toBe('job-1');
      expect(qb.limit).toHaveBeenCalledWith(1);
    });

    it('getNextJob returns null when the claim is empty', async () => {
      givenWorkerAndQueue(buildWorker(), []);

      await expect(service.getNextJob('worker-uuid')).resolves.toBeNull();
    });
  });

});
