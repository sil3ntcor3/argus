import { SystemConfig } from '@/modules/admin/system-configs/entities/system-config.entity';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { wsHeaders } from './helpers/auth';
import {
  cleanupE2eData,
  createUser,
  createWorkspace,
  type TestUser,
  type TestWorkspace,
} from './helpers/workspace';

describe('Private settings persistence (e2e)', () => {
  let ctx: TestApp;
  let user: TestUser;
  let workspace: TestWorkspace;
  let systemConfig: SystemConfig;
  const settings = {
    validation: {
      enabled: false,
      label: 'Argus',
      nested: { count: 2 },
      values: ['one', 'two'],
    },
  };

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    user = await createUser(ctx.server);
    workspace = await createWorkspace(ctx.server, user);
    systemConfig = await ctx.dataSource
      .getRepository(SystemConfig)
      .save({ name: 'Argus settings test' });
  });

  afterEach(async () => {
    if (systemConfig)
      await ctx.dataSource.getRepository(SystemConfig).delete(systemConfig.id);
    if (user)
      await cleanupE2eData(ctx.dataSource, {
        workspaceIds: workspace ? [workspace.id] : [],
        userIds: [user.userId],
      });
  });

  afterAll(async () => {
    await closeTestApp(ctx?.app);
  });

  it('defaults new system and workspace settings to empty objects', async () => {
    for (const [table, id] of [
      ['system_configs', systemConfig.id],
      ['workspaces', workspace.id],
    ]) {
      const rows: { settings: unknown }[] = await ctx.dataSource.query(
        'SELECT settings FROM ' + table + ' WHERE id = $1',
        [id],
      );
      expect(rows[0].settings).toEqual({});
    }
  });

  it('hides default settings in workspace creation responses and ignores client values', async () => {
    const res = await request(ctx.server)
      .post('/api/workspaces')
      .set('Cookie', user.cookie)
      .send({ name: 'Argus private settings', description: 'e2e', settings })
      .expect(201);
    const id = (res.body as { id: string }).id;
    try {
      expect(res.body).not.toHaveProperty('settings');
      const stored = await ctx.dataSource
        .getRepository(Workspace)
        .createQueryBuilder('workspace')
        .addSelect('workspace.settings')
        .where('workspace.id = :id', { id })
        .getOneOrFail();
      expect(stored.settings).toEqual({});
    } finally {
      await cleanupE2eData(ctx.dataSource, { workspaceIds: [id] });
    }
  });

  it('rejects null settings at the database boundary', async () => {
    for (const [table, id] of [
      ['system_configs', systemConfig.id],
      ['workspaces', workspace.id],
    ]) {
      await expect(
        ctx.dataSource.query(
          'UPDATE ' + table + ' SET settings = NULL WHERE id = $1',
          [id],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23502' } });
    }
  });

  it('round-trips nested settings independently in both stores', async () => {
    const systemRepo = ctx.dataSource.getRepository(SystemConfig);
    const workspaceRepo = ctx.dataSource.getRepository(Workspace);
    await systemRepo.update(systemConfig.id, { settings });
    await workspaceRepo.update(workspace.id, {
      settings: { workspace: { enabled: true } },
    });
    const storedSystem = await systemRepo
      .createQueryBuilder('config')
      .addSelect('config.settings')
      .where('config.id = :id', { id: systemConfig.id })
      .getOneOrFail();
    const storedWorkspace = await workspaceRepo
      .createQueryBuilder('workspace')
      .addSelect('workspace.settings')
      .where('workspace.id = :id', { id: workspace.id })
      .getOneOrFail();
    expect(storedSystem.settings).toEqual(settings);
    expect(storedWorkspace.settings).toEqual({ workspace: { enabled: true } });
  });

  it('omits private settings from default entity reads and existing HTTP responses', async () => {
    await ctx.dataSource
      .getRepository(SystemConfig)
      .update(systemConfig.id, { settings });
    await ctx.dataSource
      .getRepository(Workspace)
      .update(workspace.id, { settings });
    expect(
      await ctx.dataSource
        .getRepository(SystemConfig)
        .findOneByOrFail({ id: systemConfig.id }),
    ).toMatchObject({ settings: undefined });
    expect(
      await ctx.dataSource
        .getRepository(Workspace)
        .findOneByOrFail({ id: workspace.id }),
    ).toMatchObject({ settings: undefined });
    for (const path of [
      '/api/workspaces',
      '/api/workspaces/' + workspace.id,
      '/api/workspaces/configs',
    ]) {
      const res = await request(ctx.server)
        .get(path)
        .set(wsHeaders(user.cookie, workspace.id))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('"settings"');
    }
  });

  it('ignores private settings in existing workspace input DTOs', async () => {
    await ctx.dataSource
      .getRepository(Workspace)
      .update(workspace.id, { settings: { workspace: { enabled: true } } });
    await request(ctx.server)
      .patch('/api/workspaces/' + workspace.id)
      .set(wsHeaders(user.cookie, workspace.id))
      .send({ settings })
      .expect(200);
    await request(ctx.server)
      .patch('/api/workspaces/configs')
      .set(wsHeaders(user.cookie, workspace.id))
      .send({
        isAssetsDiscovery: false,
        isAutoEnableAssetAfterDiscovered: true,
        settings,
      })
      .expect(200);
    const stored = await ctx.dataSource
      .getRepository(Workspace)
      .createQueryBuilder('workspace')
      .addSelect('workspace.settings')
      .where('workspace.id = :id', { id: workspace.id })
      .getOneOrFail();
    expect(stored.settings).toEqual({ workspace: { enabled: true } });
  });
});
