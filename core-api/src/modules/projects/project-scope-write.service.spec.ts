import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';
import { ProjectScopeRule } from './entities/project-scope-rule.entity';
import type { ProjectScopeNormalizer } from './project-scope-normalizer.service';
import { lockProjectScope, syncProjectScope } from './project-scope-sync';
import { ProjectScopeWriteService } from './project-scope-write.service';
import type { EventBridgeService } from '../event-bridge/publishing/event-bridge.service';
import { EVENT_CATALOG } from '../event-bridge/contracts/event-catalog';

jest.mock('./project-scope-sync', () => ({
  lockProjectScope: jest.fn(),
  syncProjectScope: jest.fn(),
}));
describe('ProjectScopeWriteService', () => {
  const project = randomUUID(),
    workspace = randomUUID(),
    asset = randomUUID();
  const manager = { delete: jest.fn(), save: jest.fn(), update: jest.fn() };
  const transaction = jest.fn(
    async (work: (scoped: unknown) => Promise<unknown>) => work(manager),
  );
  const normalizer = { normalizeRules: jest.fn() };
  const bridge = { publishSafely: jest.fn() };
  let service: ProjectScopeWriteService;
  beforeEach(() => {
    jest.clearAllMocks();
    transaction.mockImplementation(async (work) => work(manager));
    bridge.publishSafely.mockReset().mockResolvedValue('1-0');
    manager.delete.mockResolvedValue({});
    manager.save.mockResolvedValue([]);
    manager.update.mockResolvedValue({});
    normalizer.normalizeRules.mockResolvedValue([]);
    jest.mocked(lockProjectScope).mockResolvedValue(project);
    jest
      .mocked(syncProjectScope)
      .mockResolvedValue({ added: [asset], removed: 2 });
    service = new ProjectScopeWriteService(
      { transaction } as unknown as DataSource,
      normalizer as unknown as ProjectScopeNormalizer,
      bridge as unknown as EventBridgeService,
    );
  });
  it.each(
    [
      null,
      {},
      [{ value: null }],
      [{ value: 'x'.repeat(256) }],
      Array.from({ length: 101 }, () => ({ value: 'x' })),
    ].map((input) => ({ input })),
  )(
    'rejects invalid bounds before opening a transaction %#',
    async ({ input }) => {
      await expect(
        service.replaceRules(project, workspace, input as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each([null, 'false', 0])(
    'rejects nonboolean preferences before persistence %#',
    async (value) => {
      await expect(
        service.replaceRules(project, workspace, [], value as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transaction).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, false, true])(
    'keeps normalization and synchronization in the locked transaction (preference=%s)',
    async (value) => {
      expect(
        await service.replaceRules(project.toUpperCase(), workspace, [], value),
      ).toEqual({ added: [asset], removed: 2 });
      expect(normalizer.normalizeRules).toHaveBeenCalledWith(
        workspace,
        [],
        manager,
      );
      expect(manager.delete).toHaveBeenCalledWith(ProjectScopeRule, {
        projectId: project,
      });
      expect(jest.mocked(syncProjectScope)).toHaveBeenCalledWith(
        manager,
        project,
        workspace,
      );
      if (value === undefined) expect(manager.update).not.toHaveBeenCalled();
      else
        expect(manager.update).toHaveBeenCalledWith(
          AssetGroup,
          { id: project },
          { autoAddAssets: value },
        );
    },
  );
  it('stores canonical rules on the resolved project', async () => {
    const rule = { mode: Mode.INCLUDE, type: Kind.ASSET, value: asset };
    normalizer.normalizeRules.mockResolvedValue([rule]);
    await service.replaceRules(project, workspace, [rule]);
    expect(manager.save).toHaveBeenCalledWith(ProjectScopeRule, [
      { ...rule, projectId: project },
    ]);
  });
  it('reports only added IDs on the canonical project subject after commit, without changing the result', async () => {
    let committed = false;
    transaction.mockImplementation(async (work) => {
      const result = await work(manager);
      expect(bridge.publishSafely).not.toHaveBeenCalled();
      committed = true;
      return result;
    });
    bridge.publishSafely.mockImplementation(() => {
      expect(committed).toBe(true);
      return Promise.resolve('1-0');
    });
    await expect(
      service.replaceRules(project.toUpperCase(), workspace, []),
    ).resolves.toEqual({ added: [asset], removed: 2 });
    expect(bridge.publishSafely).toHaveBeenCalledTimes(1);
    expect(bridge.publishSafely).toHaveBeenCalledWith(
      EVENT_CATALOG.project.assets.added,
      {
        workspaceId: workspace,
        outcome: 'success',
        resourceType: 'project',
        resourceId: project,
        payload: { projectId: project, assetIds: [asset] },
      },
      { subject: `workspace:${workspace}/project:${project}` },
    );
  });
  it.each([0, 2])(
    'does not report empty additions when removing %s members',
    async (removed) => {
      jest.mocked(syncProjectScope).mockResolvedValue({ added: [], removed });
      await expect(service.replaceRules(project, workspace, [])).resolves.toEqual(
        { added: [], removed },
      );
      expect(bridge.publishSafely).not.toHaveBeenCalled();
    },
  );
  it('does not report staged additions when committing fails', async () => {
    const failure = new Error('scope commit failed');
    transaction.mockImplementation(async (work) => {
      await work(manager);
      throw failure;
    });
    await expect(service.replaceRules(project, workspace, [])).rejects.toBe(
      failure,
    );
    expect(bridge.publishSafely).not.toHaveBeenCalled();
  });
  it.each(['normalize', 'sync'])(
    'propagates %s failures to the transaction owner',
    async (stage) => {
      const failure = new Error('scope write failed');
      if (stage === 'normalize')
        normalizer.normalizeRules.mockRejectedValue(failure);
      else jest.mocked(syncProjectScope).mockRejectedValue(failure);
      await expect(service.replaceRules(project, workspace, [])).rejects.toBe(
        failure,
      );
      expect(bridge.publishSafely).not.toHaveBeenCalled();
    },
  );
});
