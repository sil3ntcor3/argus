import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import { isEventName } from '@/modules/event-bridge/contracts/event-catalog';
import { AuditSink } from '@/modules/event-bridge/sinks/audit/audit.sink';
import { AuditEvent } from '@/modules/audit/entities/audit-event.entity';

describe('Canonical Projects CRUD (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let projectId: string;
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'projects-api-owner');
    other = await createUserWithWorkspace(app.server, 'projects-api-other');
    const [row]: { id: string }[] = await app.dataSource.query(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2) RETURNING id',
      ['Argus protected project', owner.workspace.id],
    );
    projectId = row.id;
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('shares create, filtered list, read, update and delete with legacy Groups', async () => {
    const name = 'Argus project ' + randomUUID();
    const created = await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name, hexColor: '#123456' })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const list = await request(app.server)
      .get('/api/projects')
      .query({ search: name, limit: 1, page: 1 })
      .set(owner.headers)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id, name, hexColor: '#123456' });
    await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(200);
    await request(app.server)
      .patch(`/api/projects/${id}`)
      .set(owner.headers)
      .send({ name: name + ' canonical' })
      .expect(200);
    const legacy = await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(legacy.body.name).toBe(name + ' canonical');
    await request(app.server)
      .patch(`/api/asset-group/${id}`)
      .set(owner.headers)
      .send({ name: name + ' legacy' })
      .expect(200);
    const canonical = await request(app.server)
      .get(`/api/projects/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(canonical.body.name).toBe(name + ' legacy');
    await request(app.server)
      .delete(`/api/projects/${id}`)
      .set(owner.headers)
      .expect(200);
    await request(app.server)
      .get(`/api/asset-group/${id}`)
      .set(owner.headers)
      .expect(404);
  });

  it('keeps authentication and workspace boundaries on every operation', async () => {
    const http = request(app.server);
    for (const method of ['get', 'patch', 'delete'] as const) {
      await http[method](`/api/projects/${projectId}`)
        .send({ name: 'Denied' })
        .expect(401);
      await http[method](`/api/projects/${projectId}`)
        .set(other.headers)
        .send({ name: 'Denied' })
        .expect(404);
      await http[method](`/api/projects/${projectId}`)
        .set(owner.headers)
        .set('X-Workspace-Id', other.workspace.id)
        .send({ name: 'Denied' })
        .expect((response: request.Response) => {
          if (response.status !== 403) {
            const body = response.body as { message?: unknown };
            throw new Error(
              `${method}: expected 403, got ${response.status}; message=${JSON.stringify(body.message)}`,
            );
          }
        });
    }
    await request(app.server)
      .post('/api/projects')
      .send({ name: 'Denied' })
      .expect(401);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .set('X-Workspace-Id', other.workspace.id)
      .send({ name: 'Denied' })
      .expect(403);
    const list = await request(app.server)
      .get('/api/projects')
      .set(other.headers)
      .expect(200);
    expect(list.body.data).toEqual([]);
    const unchanged = await request(app.server)
      .get(`/api/projects/${projectId}`)
      .set(owner.headers)
      .expect(200);
    expect(unchanged.body.name).toBe('Argus protected project');
  });

  it('validates identifiers, creation input and list parameters before persistence', async () => {
    const http = request(app.server);
    for (const method of ['get', 'patch', 'delete'] as const)
      await http[method]('/api/projects/not-a-uuid')
        .set(owner.headers)
        .send({ name: 'Invalid' })
        .expect(400);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({})
      .expect(400);
    await request(app.server)
      .post('/api/projects')
      .set(owner.headers)
      .send({ name: 'Invalid', hexColor: 'not-a-color' })
      .expect(400);
    await request(app.server)
      .get('/api/projects')
      .query({ page: 0 })
      .set(owner.headers)
      .expect(400);
  });

  it('documents distinct canonical operations while retaining legacy identifiers', () => {
    const document = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder().build(),
    );
    const paths = document.paths;
    expect(paths['/api/projects']?.get?.operationId).toBe(
      'ProjectsController_getMany',
    );
    expect(paths['/api/projects']?.post?.operationId).toBe(
      'ProjectsController_create',
    );
    expect(paths['/api/projects']?.post?.responses?.['201']).toBeDefined();
    for (const [method, name] of [
      ['get', 'getById'],
      ['patch', 'update'],
      ['delete', 'delete'],
    ] as const)
      expect(paths['/api/projects/{id}']?.[method]?.operationId).toBe(
        'ProjectsController_' + name,
      );
    expect(paths['/api/asset-group']?.get?.operationId).toBe(
      'AssetGroupController_getAll',
    );
    const ids: string[] = [];
    for (const path of Object.values(paths as Record<string, unknown>)) {
      if (!path || typeof path !== 'object') continue;
      for (const operation of Object.values(path as Record<string, unknown>)) {
        if (
          operation &&
          typeof operation === 'object' &&
          'operationId' in operation &&
          typeof operation.operationId === 'string' &&
          operation.operationId.startsWith('ProjectsController_')
        )
          ids.push(operation.operationId);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('records canonical CRUD and scope activity with actor, tenant, resource and safe numeric counts', async () => {
    const publish = jest
      .spyOn(app.app.get(EventBridgeService), 'publish')
      .mockResolvedValue('1-0');
    try {
      const created = await request(app.server)
        .post('/api/projects')
        .set(owner.headers)
        .send({ name: randomUUID() })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await request(app.server)
        .patch(`/api/projects/${id}`)
        .set(owner.headers)
        .send({ description: 'saved' })
        .expect(200);
      await request(app.server)
        .put(`/api/projects/${id}/scope-rules`)
        .set(owner.headers)
        .send({ rules: [], autoAddAssets: false })
        .expect(200);
      const [saved]: { autoAddAssets: boolean }[] = await app.dataSource.query(
        'SELECT "autoAddAssets" FROM projects WHERE id=$1',
        [id],
      );
      expect(saved.autoAddAssets).toBe(false);
      await request(app.server)
        .delete(`/api/projects/${id}`)
        .set(owner.headers)
        .expect(200);
      const calls = publish.mock.calls.filter((call) =>
        typeof call[0] === 'string' && call[0].startsWith('project.'),
      );
      expect(calls.map((call) => call[0])).toEqual([
        'project.created',
        'project.updated',
        'project.updated',
        'project.deleted',
      ]);
      const sink = app.app.get(AuditSink);
      for (const [name, raw, options] of calls) {
        const data = raw as EventEnvelopeData;
        expect(data).toMatchObject({
          workspaceId: owner.workspace.id,
          actor: { id: owner.user.userId, type: 'user' },
          resourceType: 'project',
          resourceId: id,
          outcome: 'success',
        });
        expect(options?.subject).toBe(
          `workspace:${owner.workspace.id}/project:${id}`,
        );
        if (typeof name !== 'string' || !isEventName(name))
          throw new Error('Expected a declared event');
        await sink.handle(name, {
          ...data,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
        });
      }
      expect(calls[1][1]).toMatchObject({ metadata: { change: 'settings' } });
      expect(calls[2][1]).toMatchObject({
        metadata: { change: 'scope', added: 0, removed: 0 },
      });
      expect(
        publish.mock.calls.some((call) =>
          typeof call[0] === 'string' && call[0].startsWith('asset_group.'),
        ),
      ).toBe(false);
      const rows = await app.dataSource
        .getRepository(AuditEvent)
        .find({
          where: { workspaceId: owner.workspace.id, resourceId: id },
          select: { action: true },
        });
      expect(rows.map((row) => row.action).sort()).toEqual(
        [
          'project.created',
          'project.updated',
          'project.updated',
          'project.deleted',
        ].sort(),
      );
    } finally {
      publish.mockRestore();
    }
  });

  it('attributes failed canonical attempts without success counts and emits nothing for anonymous or read requests', async () => {
    const publish = jest
      .spyOn(app.app.get(EventBridgeService), 'publish')
      .mockResolvedValue('1-0');
    try {
      await request(app.server)
        .put(`/api/projects/${projectId}/scope-rules`)
        .set(owner.headers)
        .send({ rules: null })
        .expect(400);
      await request(app.server)
        .patch(`/api/projects/${projectId}`)
        .set(other.headers)
        .send({ name: 'Denied' })
        .expect(404);
      const calls = publish.mock.calls.filter(
        (call) => call[0] === 'project.updated',
      );
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toMatchObject({
        workspaceId: owner.workspace.id,
        resourceId: projectId,
        outcome: 'failure',
        metadata: { change: 'scope' },
      });
      expect((calls[0][1] as EventEnvelopeData).metadata).not.toHaveProperty(
        'added',
      );
      expect(calls[1][1]).toMatchObject({
        workspaceId: other.workspace.id,
        actor: { id: other.user.userId },
        resourceId: projectId,
        outcome: 'failure',
      });
      publish.mockClear();
      await request(app.server)
        .get(`/api/projects/${projectId}`)
        .set(owner.headers)
        .expect(200);
      await request(app.server)
        .patch(`/api/projects/${projectId}`)
        .send({ name: 'Denied' })
        .expect(401);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      publish.mockRestore();
    }
  });

  it('retains legacy group audit actions beside the canonical project dictionary', async () => {
    const publish = jest
      .spyOn(app.app.get(EventBridgeService), 'publish')
      .mockResolvedValue('1-0');
    try {
      const created = await request(app.server)
        .post('/api/asset-group')
        .set(owner.headers)
        .send({ name: randomUUID() })
        .expect(201);
      await request(app.server)
        .delete(`/api/asset-group/${(created.body as { id: string }).id}`)
        .set(owner.headers)
        .expect(200);
      expect(publish.mock.calls.map((call) => call[0])).toEqual([
        'asset_group.created',
        'asset_group.deleted',
      ]);
      const actions = await request(app.server)
        .get(`/api/workspaces/${owner.workspace.id}/audit/actions`)
        .set(owner.headers)
        .expect(200);
      expect(
        (actions.body as { data: { action: string }[] }).data.map(
          (row) => row.action,
        ),
      ).toEqual(
        expect.arrayContaining([
          'asset_group.created',
          'asset_group.deleted',
          'project.created',
          'project.updated',
          'project.deleted',
        ]),
      );
    } finally {
      publish.mockRestore();
    }
  });
});
