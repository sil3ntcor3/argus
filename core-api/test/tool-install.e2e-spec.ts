import { AuditOutcome, DataKind } from '@/common/enums/enum';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';
import { Tool } from '@/modules/tools/entities/tools.entity';
import { WorkspaceTool } from '@/modules/tools/entities/workspace_tools.entity';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Validate installation errors and tenant boundaries against local Postgres. */
describe('Tool installation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let audited: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let toolId: string;
  const missing = randomUUID();

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'tool-install-owner');
    other = await createUserWithWorkspace(app.server, 'tool-install-other');
    audited = await createUserWithWorkspace(app.server, 'tool-audit-owner');
    toolId = (
      await app.dataSource
        .getRepository(Tool)
        .findOneByOrFail({ name: 'nuclei' })
    ).id!;
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [
        owner?.workspace.id,
        other?.workspace.id,
        audited?.workspace.id,
      ].filter(Boolean),
      userIds: [
        owner?.user.userId,
        other?.user.userId,
        audited?.user.userId,
      ].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('exposes backward-compatible input/output metadata on the tool catalog', async () => {
    for (const [name, inputs, produces] of [
      ['nuclei', [DataKind.HOST], [DataKind.VULNERABILITY]],
      ['gitleaks', [DataKind.REPOSITORY], [DataKind.VULNERABILITY]],
      ['subfinder', [DataKind.TARGET], [DataKind.HOST]],
    ] as const) {
      const response = await request(app.server)
        .get('/api/tools')
        .query({ search: name })
        .set(owner.headers)
        .expect(200);
      const tool = response.body.data.find((row: { name: string }) => row.name === name);
      expect(tool.categories[0]).toMatchObject({ inputs, produces });
      const stored = await app.dataSource.getRepository(Tool).findOneByOrFail({ name });
      expect(stored.categories?.[0]).toMatchObject({ inputs, produces });
    }
  });

  it('returns 404 for an unknown tool without exposing an FK failure or creating a row', async () => {
    const res = await request(app.server)
      .post('/api/tools/install')
      .set(owner.headers)
      .send({ toolId: missing })
      .expect(404);
    expect(res.body.message).toBe(`Tool with ID "${missing}" not found.`);
    expect(JSON.stringify(res.body)).not.toMatch(/foreign key|SQL|constraint/i);
    expect(
      await app.dataSource.getRepository(WorkspaceTool).count({
        where: { workspace: { id: owner.workspace.id } },
      }),
    ).toBe(0);
  });

  it('keeps installation and duplicate checks scoped to each workspace', async () => {
    const install = (headers: Record<string, string>) =>
      request(app.server)
        .post('/api/tools/install')
        .set(headers)
        .send({ toolId });
    const first = await install(owner.headers).expect(201);
    expect(first.body.tool).toEqual({ id: toolId, name: 'nuclei' });
    expect(first.body.workspace).toEqual({ id: owner.workspace.id });
    await install(owner.headers)
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toBe('Tool already installed in this workspace.');
      });
    const second = await install(other.headers).expect(201);
    expect(second.body.workspace).toEqual({ id: other.workspace.id });
  });

  it('applies authentication and workspace access checks before tool lookup', async () => {
    for (const id of [missing, toolId]) {
      await request(app.server)
        .post('/api/tools/install')
        .set('X-Workspace-Id', owner.workspace.id)
        .send({ toolId: id })
        .expect(401);
      await request(app.server)
        .post('/api/tools/install')
        .set('Cookie', other.user.cookie)
        .set('X-Workspace-Id', owner.workspace.id)
        .send({ toolId: id })
        .expect(403);
    }
  });

  it('persists attributed success and failure events without crossing workspace boundaries', async () => {
    const operate = (operation: string, id = toolId) =>
      request(app.server)
        .post(`/api/tools/${operation}`)
        .set(audited.headers)
        .send({ toolId: id });
    await operate('install').expect(201);
    await operate('install').expect(400);
    const removed = await operate('uninstall').expect(201);
    expect(removed.body).toEqual({
      message: 'Tool uninstalled successfully.',
      toolId,
      toolName: 'nuclei',
    });
    await operate('uninstall').expect(400);
    await operate('install', missing).expect(404);

    const repository = app.dataSource.getRepository(AuditEvent);
    const where = { workspaceId: audited.workspace.id, resourceType: 'tool' };
    let rows: AuditEvent[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = await repository.find({ where });
      if (rows.length >= 5) break;
      await delay(100);
    }
    expect(rows).toHaveLength(5);
    const successful = rows.filter(
      (row) => row.outcome === AuditOutcome.Success,
    );
    expect(successful).toHaveLength(2);
    for (const [action, changes] of [
      ['tool.installed', { tool: { after: 'nuclei' } }],
      ['tool.uninstalled', { tool: { before: 'nuclei' } }],
    ] as const) {
      expect(successful.find((row) => row.action === action)).toMatchObject({
        actorId: audited.user.userId,
        resourceType: 'tool',
        resourceId: toolId,
        changes,
      });
    }
    expect(
      rows.filter((row) => row.outcome === AuditOutcome.Failure),
    ).toHaveLength(3);
    expect(rows.every((row) => row.actorId === audited.user.userId)).toBe(true);
    const listed = await request(app.server)
      .get(
        `/api/workspaces/${audited.workspace.id}/audit?action=tool.installed`,
      )
      .set(audited.headers)
      .expect(200);
    expect(listed.body.data).toHaveLength(3);
    await request(app.server)
      .get(`/api/workspaces/${audited.workspace.id}/audit`)
      .set(other.headers)
      .expect(403);
    expect(
      await repository.count({
        where: {
          workspaceId: other.workspace.id,
          resourceType: 'tool',
          outcome: AuditOutcome.Success,
        },
      }),
    ).toBe(1);
  });
});
