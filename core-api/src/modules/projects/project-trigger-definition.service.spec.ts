import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { Workflow } from '../workflows/entities/workflow.entity';
import { ProjectWorkflowTrigger } from './entities/project-workflow-trigger.entity';
import { ProjectTriggerDefinitionService } from './project-trigger-definition.service';

describe('ProjectTriggerDefinitionService', () => {
  const projectId = randomUUID(),
    workspaceId = randomUUID(),
    bindingId = randomUUID();
  function setup(on: unknown = { target: ['domain'], schedule: '0 6 * * *' }) {
    const workflow = {
      id: randomUUID(),
      name: 'Keep',
      isCanEdit: true,
      filePath: `project-${projectId}-owned.yaml`,
      content: {
        name: 'Keep',
        jobs: { probe: { run: 'httpx', config: { secret: 'ciphertext' } } },
        on,
      },
    };
    const query = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(workflow),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([{ id: projectId, archivedAt: null }]),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: bindingId, workflowId: workflow.id }),
      getRepository: () => ({ createQueryBuilder: () => query }),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((_entity: unknown, value: unknown) =>
        Promise.resolve(value),
      ),
    };
    const transaction = jest.fn((fn: (m: typeof manager) => Promise<unknown>) =>
      fn(manager),
    );
    const service = new ProjectTriggerDefinitionService({
      transaction,
    } as unknown as DataSource);
    const create = (definition: unknown) =>
      service.createDisabled(projectId, workspaceId, bindingId, definition);
    return { create, service, manager, workflow, query, transaction };
  }

  it('adds a normalized disabled row while preserving the graph, ciphertext and legacy target', async () => {
    const { create, manager, workflow } = setup();
    const before = structuredClone(workflow);
    await expect(
      create({ 'project.run.completed': true }),
    ).resolves.toMatchObject({
      projectWorkflowId: bindingId,
      type: 'event',
      event: 'project.run.completed',
      cron: null,
      config: {
        windowMinutes: 10,
        maxAssets: 200,
        targetTypes: [],
        workflows: [],
        status: ['success'],
      },
      enabled: false,
      schedulerId: null,
      lastFiredAt: null,
    });
    expect(manager.save).toHaveBeenNthCalledWith(1, Workflow, {
      ...workflow,
      content: {
        ...workflow.content,
        on: {
          ...(workflow.content.on as object),
          'project.run.completed': expect.any(Object),
        },
      },
    });
    expect(manager.find).toHaveBeenCalledWith(ProjectWorkflowTrigger, {
      where: { projectWorkflowId: bindingId },
    });
    expect(workflow).toEqual(before);
  });

  it('appends a cron without overwriting existing schedules or event settings', async () => {
    const on = {
      target: ['url'],
      schedule: '0 6 * * *',
      'project.assets.added': { maxAssets: 9 },
    };
    const { create, manager } = setup(on);
    await expect(
      create({ schedule: '  0   8 * * *  ' }),
    ).resolves.toMatchObject({ cron: '0 8 * * *', event: null, config: {} });
    expect(manager.save.mock.calls[0][1]).toMatchObject({
      content: {
        on: {
          ...on,
          schedule: [{ cron: '0 6 * * *' }, { cron: '0 8 * * *' }],
        },
      },
    });
  });

  it.each([
    {},
    { target: ['url'] },
    { schedule: 'disabled' },
    { schedule: 'bad' },
    { unknown: true },
    ...['Recon\0', '\uD800', '\uDC00'].map((name) => ({
      'project.run.completed': { workflows: [name] },
    })),
    { 'project.assets.added': { maxAssets: 0 } },
    { schedule: '0 1 * * *', 'project.assets.added': true },
  ])(
    'rejects invalid or multiple definitions before opening a transaction: %j',
    async (input) => {
      const { create, transaction } = setup();
      await expect(create(input)).rejects.toMatchObject({ status: 400 });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(['file', 'row'])(
    'rejects a duplicate canonical key in the %s',
    async (source) => {
      const { create, manager } = setup(
        source === 'file' ? { schedule: ' 0  8 * * * ' } : {},
      );
      if (source === 'row')
        manager.find.mockResolvedValue([
          { type: 'cron', cron: '0  8 * * *', event: null },
        ]);
      await expect(create({ schedule: '0 8 * * *' })).rejects.toMatchObject({
        status: 400,
      });
      expect(manager.save).not.toHaveBeenCalled();
    },
  );

  it('refuses an invalid stored on block without discarding authored data', async () => {
    const { create, manager } = setup({ customTrigger: { opaque: true } });
    await expect(
      create({ 'project.assets.added': true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(manager.save).not.toHaveBeenCalled();
  });  it('updates a cron in place without resetting its activation or history', async () => {
    const { service, manager } = setup({ target: ['domain'], schedule: '0 6 * * *' });
    const row = { id: randomUUID(), projectWorkflowId: bindingId, type: 'cron', cron: '0 6 * * *', event: null, config: {}, enabled: true, lastFiredAt: new Date() };
    manager.find.mockResolvedValue([row]);
    jest.spyOn(service, 'bindingOf').mockResolvedValue(bindingId);
    const result = await service.update(projectId, workspaceId, row.id, { cron: '0 9 * * *' });
    expect(result).toMatchObject({ ...row, cron: '0 9 * * *' });
    expect(manager.save.mock.calls[0][1]).toMatchObject({ content: { on: { target: ['domain'], schedule: [{ cron: '0 9 * * *' }] } } });
  });
  it('merges an event config patch and preserves unrelated definitions', async () => {
    const { service, manager } = setup({ schedule: '0 6 * * *', 'project.assets.added': { maxAssets: 9, windowMinutes: 1 } });
    const row = { id: randomUUID(), projectWorkflowId: bindingId, type: 'event', cron: null, event: 'project.assets.added', config: { maxAssets: 9, windowMinutes: 1 }, enabled: false };
    manager.find.mockResolvedValue([row]);
    jest.spyOn(service, 'bindingOf').mockResolvedValue(bindingId);
    const result = await service.update(projectId, workspaceId, row.id, { config: { windowMinutes: 0 }, enabled: true });
    expect(result).toMatchObject({ id: row.id, enabled: true, config: { maxAssets: 9, windowMinutes: 0 } });
    expect(manager.save.mock.calls[0][1]).toMatchObject({ content: { on: { schedule: [{ cron: '0 6 * * *' }] } } });
  });

});
