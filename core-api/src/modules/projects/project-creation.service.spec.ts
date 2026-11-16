import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProjectCreationService } from './project-creation.service';
import type { CreateProjectDto } from './dto/project-metadata-input.dto';
import { Tool } from '../tools/entities/tools.entity';
import { AssetGroup } from '../asset-group/entities/asset-groups.entity';

describe('ProjectCreationService', () => {
  const project = randomUUID(),
    workspace = randomUUID(),
    tool = randomUUID(),
    second = randomUUID();
  const jobs = { probe: { run: 'subfinder' } };
  function setup() {
    const manager = {
      queryRunner: { isTransactionActive: true },
      query: jest.fn().mockResolvedValue([{ id: project }]),
      exists: jest.fn().mockResolvedValue(false),
      save: jest.fn().mockResolvedValue({ id: project }),
      find: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === Tool
            ? [
                { id: tool, name: 'subfinder' },
                { id: second, name: 'httpx' },
              ]
            : [],
        ),
      ),
      findOneByOrFail: jest.fn().mockResolvedValue({ content: { jobs } }),
    };
    const db = {
      transaction: jest.fn((callback: (m: typeof manager) => unknown) =>
        callback(manager),
      ),
      query: jest.fn().mockResolvedValue([{ count: 1 }]),
    };
    const legacy = { create: jest.fn().mockResolvedValue({ id: project }) },
      metadata = { getById: jest.fn().mockResolvedValue({ id: project }) };
    const scope = { normalizeRules: jest.fn().mockResolvedValue([]) },
      workflows = {
        createWithin: jest
          .fn()
          .mockResolvedValue({ id: 'binding', workflowId: 'workflow' }),
      };
    const validateJobs = { prepare: jest.fn().mockResolvedValue(jobs) },
      encryption = { getDEK: jest.fn().mockResolvedValue(Buffer.alloc(32)) };
    const actions = {
        run: jest.fn().mockResolvedValue({ jobHistoryId: 'run' }),
      },
      runtime = { reconcile: jest.fn().mockResolvedValue(undefined) };
    const service = new ProjectCreationService(
      db as never,
      legacy as never,
      metadata as never,
      scope as never,
      workflows as never,
      validateJobs as never,
      encryption as never,
      actions as never,
      runtime as never,
    );
    return {
      service,
      db,
      manager,
      legacy,
      metadata,
      scope,
      workflows,
      validateJobs,
      encryption,
      actions,
      runtime,
    };
  }
  it('delegates unchanged legacy creation without resolving encryption or opening a composition transaction', async () => {
    const s = setup(),
      dto = { name: 'Legacy', toolIds: [tool] };
    expect(await s.service.create(dto, workspace, false)).toEqual({
      id: project,
    });
    expect(s.legacy.create).toHaveBeenCalledWith(dto, workspace, dto);
    expect(s.db.transaction).not.toHaveBeenCalled();
    expect(s.encryption.getDEK).not.toHaveBeenCalled();
  });
  it.each([
    { runNow: true },
    { workflowName: 'Missing' },
    { on: {} },
    { scopeRules: [], schedule: '0 8 * * *' },
    { jobs, template: 'default.yaml' },
  ])(
    'rejects inconsistent pipeline settings before setup: %j',
    async (extra) => {
      const s = setup();
      await expect(
        s.service.create({ name: 'Argus', ...extra }, workspace, true),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    { runNow: true },
    { on: { schedule: [{ cron: '0 8 * * *', enabled: true }] } },
    {
      on: {
        events: [{ event: 'project.assets.added' as const, enabled: true }],
      },
    },
  ])(
    'requires launch permission before any key/write operation: %j',
    async (extra) => {
      const s = setup();
      await expect(
        s.service.create({ name: 'Argus', jobs, ...extra }, workspace, false),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(s.encryption.getDEK).not.toHaveBeenCalled();
      expect(s.db.transaction).not.toHaveBeenCalled();
    },
  );
  it('creates a rule-only project with explicit membership preference and no workflow or key operation', async () => {
    const s = setup();
    await expect(
      s.service.create(
        { name: '  Argus  ', scopeRules: [], autoAddAssets: false },
        workspace,
        false,
      ),
    ).resolves.toEqual({ id: project, creation: {} });
    expect(s.manager.save).toHaveBeenCalledWith(
      AssetGroup,
      expect.objectContaining({ name: 'Argus', autoAddAssets: false }),
    );
    expect(s.workflows.createWithin).not.toHaveBeenCalled();
    expect(s.encryption.getDEK).not.toHaveBeenCalled();
  });
  it('resolves legacy tools into the existing staged graph while preserving input and profile settings', async () => {
    const s = setup();
    await s.service.create(
      {
        name: 'Argus',
        scopeRules: [],
        tools: [
          { toolId: tool, stage: 1 },
          { toolId: second, stage: 2, configProfileId: 'profile' },
        ],
      },
      workspace,
      false,
    );
    expect(s.workflows.createWithin).toHaveBeenCalledWith(
      s.manager,
      project,
      workspace,
      expect.objectContaining({
        jobs: {
          subfinder: { run: 'subfinder' },
          httpx: {
            run: 'httpx',
            needs: ['subfinder'],
            configProfileId: 'profile',
          },
        },
      }),
      expect.any(Buffer),
    );
  });
  it('keeps disabled definitions editable by project writers and gives explicit on precedence over schedule', async () => {
    const s = setup();
    await s.service.create(
      {
        name: 'Argus',
        jobs,
        on: { schedule: [{ cron: '0 8 * * *', enabled: false }] },
        schedule: '0 9 * * *',
      },
      workspace,
      false,
    );
    expect(s.runtime.reconcile).toHaveBeenCalledTimes(1);
    expect(s.actions.run).not.toHaveBeenCalled();
    expect(s.workflows.createWithin).toHaveBeenCalledWith(
      s.manager,
      project,
      workspace,
      expect.objectContaining({
        on: { schedule: [{ cron: '0 8 * * *', enabled: false }] },
      }),
      expect.any(Buffer),
    );
  });
  it('validates copied template references inside the same setup transaction', async () => {
    const s = setup();
    await s.service.create(
      { name: 'Argus', template: 'scan.yaml' },
      workspace,
      false,
    );
    expect(s.validateJobs.prepare).toHaveBeenCalledWith(
      s.manager,
      workspace,
      jobs,
      jobs,
      expect.any(Buffer),
      { preserveOnlyCiphertext: true },
    );
  });
  it('keeps a postcommit scope lookup failure inside the generic launch outcome', async () => {
    const s = setup();
    s.db.query.mockRejectedValueOnce(new Error('private query'));
    expect(
      await s.service.create(
        { name: 'Argus', jobs, runNow: true },
        workspace,
        true,
      ),
    ).toEqual({ id: project, creation: { initialRun: { status: 'failed' } } });
    expect(s.actions.run).not.toHaveBeenCalled();
  });
  it('does not attempt an initial run when there are no enabled scope members', async () => {
    const s = setup();
    s.db.query.mockResolvedValueOnce([{ count: 0 }]);
    expect(
      await s.service.create(
        { name: 'Argus', jobs, runNow: true },
        workspace,
        true,
      ),
    ).toMatchObject({ creation: { initialRun: { status: 'empty_scope' } } });
    expect(s.actions.run).not.toHaveBeenCalled();
  });
  it('returns generic postcommit outcomes without exposing external errors or deleting setup', async () => {
    const s = setup();
    s.actions.run.mockRejectedValueOnce(new Error('PRIVATE_TOKEN'));
    s.runtime.reconcile.mockRejectedValueOnce(new Error('PRIVATE_REDIS'));
    const result = await s.service.create(
      { name: 'Argus', jobs, runNow: true, on: {} },
      workspace,
      true,
    );
    expect(result).toEqual({
      id: project,
      creation: { initialRun: { status: 'failed' }, triggerSync: 'pending' },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });
  it('rejects a disappeared workspace and duplicate name before persisting the project', async () => {
    for (const missing of [true, false]) {
      const s = setup();
      if (missing) s.manager.query.mockResolvedValueOnce([]);
      else s.manager.exists.mockResolvedValueOnce(true);
      await expect(
        s.service.create({ name: 'Argus', scopeRules: [] }, workspace, false),
      ).rejects.toBeInstanceOf(
        missing ? NotFoundException : BadRequestException,
      );
      expect(s.manager.save).not.toHaveBeenCalled();
    }
  });
  it.each([
    { name: ' ' },
    { name: 'bad\u0000name' },
    { name: 'Argus', description: 'bad\u0000description' },
    { name: 'Argus', on: { unknown: true } },
  ])(
    'rejects invalid metadata and trigger input before setup: %j',
    async (extra) => {
      const s = setup();
      await expect(
        s.service.create(
          { scopeRules: [], jobs, ...extra } as CreateProjectDto,
          workspace,
          true,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.db.transaction).not.toHaveBeenCalled();
    },
  );
});
