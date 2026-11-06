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
  let service: ProjectScopeWriteService;
  beforeEach(() => {
    jest.clearAllMocks();
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
    },
  );
});
