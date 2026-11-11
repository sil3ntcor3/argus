import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { EventBridgeService } from '@/modules/event-bridge/publishing/event-bridge.service';
import { EVENT_CATALOG } from '@/modules/event-bridge/contracts/event-catalog';
import type { EventEnvelopeData } from '@/modules/event-bridge/contracts/event-envelope';
import type { ProjectAssetsAddedPayload } from '@/modules/event-bridge/contracts/event-payloads';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import type { QueryRunner } from 'typeorm';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Canonical project manual-add API (e2e)', () => {
  let app: TestApp, observer: QueryRunner;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let project: string, foreign: string, role: string;
  const assets: string[] = [];
  let publish: jest.SpiedFunction<EventBridgeService['publishSafely']>,
    reported: EventEnvelopeData[];
  let auditPublish: jest.SpiedFunction<EventBridgeService['publish']>;
  const path = (id: string) => '/api/projects/' + id + '/assets';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const state = () =>
    app.dataSource.query(
      'SELECT "assetId",source,"scopeRuleId","updatedAt" FROM project_assets WHERE "projectId"=$1 ORDER BY "assetId"',
      [project],
    );
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'manual-api-owner');
    reader = await createUserWithWorkspace(app.server, 'manual-api-reader');
    for (const [index, context] of [owner, reader].entries()) {
      const id = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), context.workspace.id],
      );
      if (index === 0) project = id;
      else foreign = id;
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['manual-api.argus.test', 'DOMAIN', context.workspace.id],
      );
      for (const name of index === 0 ? ['new', 'rule', 'manual'] : ['foreign'])
        assets.push(
          await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
            name + '.manual-api.argus.test',
            target,
          ]),
        );
    }
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      ['Manual API reader', ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
    observer = app.dataSource.createQueryRunner();
    await observer.connect();
  });
  beforeEach(async () => {
    await app.dataSource.query(
      'DELETE FROM project_assets WHERE "projectId"=$1',
      [project],
    );
    await app.dataSource.query(
      'DELETE FROM project_scope_rules WHERE "projectId"=$1',
      [project],
    );
    const rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'asset', assets[1]],
    );
    await app.dataSource.query(
      'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId") VALUES ($1,$2,$3,$4),($1,$5,$6,NULL)',
      [project, assets[1], 'rule', rule, assets[2], 'manual'],
    );
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [['project.read'], role],
    );
    reported = [];
    auditPublish = jest
      .spyOn(app.app.get(EventBridgeService), 'publish')
      .mockResolvedValue('1-0');
    publish = jest
      .spyOn(app.app.get(EventBridgeService), 'publishSafely')
      .mockImplementation(async (name, raw, options) => {
        if (name === EVENT_CATALOG.project.assets.added) {
          const data = raw as EventEnvelopeData,
            payload = data.payload as ProjectAssetsAddedPayload;
          expect(data).toMatchObject({
            workspaceId: owner.workspace.id,
            resourceType: 'project',
            resourceId: project,
            outcome: 'success',
          });
          expect(payload).toEqual({
            projectId: project,
            assetIds: [assets[0]],
          });
          expect(options).toEqual({
            subject: `workspace:${owner.workspace.id}/project:${project}`,
          });
          expect(
            await observer.manager.query(
              'SELECT "assetId" FROM project_assets WHERE "projectId"=$1 AND "assetId"=ANY($2::uuid[])',
              [project, payload.assetIds],
            ),
          ).toEqual([{ assetId: assets[0] }]);
          reported.push(data);
        }
        return null;
      });
  });
  afterEach(() => {
    publish.mockRestore();
    auditPublish.mockRestore();
  });
  afterAll(async () => {
    await observer?.release();
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('adds and promotes after commit, returns only a numeric count/message and preserves legacy duplicate errors', async () => {
    const result = await request(app.server)
      .post(path(project.toUpperCase()))
      .set(owner.headers)
      .send({
        assetIds: [assets[0].toUpperCase(), assets[0], assets[1], assets[2]],
      })
      .expect(201);
    expect(result.body).toEqual({
      message: '1 assets added to the project',
      count: 1,
    });
    expect(reported).toHaveLength(1);
    const first = await state();
    expect(first).toHaveLength(3);
    expect(
      first.every(
        (row: { source: string; scopeRuleId: string | null }) =>
          row.source === 'manual' && row.scopeRuleId === null,
      ),
    ).toBe(true);
    expect(
      (
        await request(app.server)
          .post(path(project))
          .set(owner.headers)
          .send({ assetIds: [assets[0], assets[1]] })
          .expect(201)
      ).body,
    ).toEqual({ message: '0 assets added to the project', count: 0 });
    expect(await state()).toEqual(first);
    expect(reported).toHaveLength(1);
    await request(app.server)
      .post('/api/asset-group/' + project + '/assets')
      .set(owner.headers)
      .send({ assetIds: [assets[0]] })
      .expect(400);
    const event = auditPublish.mock.calls.find(
      ([name, data]) =>
        name === EVENT_CATALOG.project.updated.name &&
        (data as EventEnvelopeData)?.metadata?.added === 1,
    )?.[1] as EventEnvelopeData;
    expect(event).toMatchObject({
      workspaceId: owner.workspace.id,
      actor: { type: 'user', id: owner.user.userId },
      metadata: { change: 'assets.added', added: 1 },
    });
  });
  it('honors canonical and legacy write grants and accepts authorized empty requests', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const [index, key] of ['project.write', 'group.write'].entries()) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[key], role],
      );
      expect(
        (
          await request(app.server)
            .post(path(project))
            .set(headers)
            .send({ assetIds: [assets[0]] })
            .expect(201)
        ).body.count,
      ).toBe(index === 0 ? 1 : 0);
    }
    expect(
      (
        await request(app.server)
          .post(path(project))
          .set(owner.headers)
          .send({ assetIds: [] })
          .expect(201)
      ).body.count,
    ).toBe(0);
    expect(reported).toHaveLength(1);
  });
  it('rejects invalid arrays and mixed missing or foreign candidates atomically without an addition fact', async () => {
    const before = await state();
    for (const body of [
      {},
      { assetIds: null },
      { assetIds: 'invalid' },
      { assetIds: [null] },
      { assetIds: ['invalid'] },
      { assetIds: [assets[0], assets[0]] },
      { assetIds: Array.from({ length: 1001 }, () => randomUUID()) },
    ])
      await request(app.server)
        .post(path(project))
        .set(owner.headers)
        .send(body)
        .expect(400);
    for (const id of [assets[3], randomUUID()])
      await request(app.server)
        .post(path(project))
        .set(owner.headers)
        .send({ assetIds: [assets[0], id] })
        .expect(404);
    expect(await state()).toEqual(before);
    expect(reported).toEqual([]);
  });
  it('retains reader denial, authentication, project tenancy and route validation', async () => {
    const data = { assetIds: [assets[0]] },
      before = await state();
    await request(app.server)
      .post(path(project))
      .set({ ...reader.headers, 'X-Workspace-Id': owner.workspace.id })
      .send(data)
      .expect(403);
    await request(app.server)
      .post(path(project))
      .set('X-Workspace-Id', owner.workspace.id)
      .send(data)
      .expect(401);
    for (const id of [foreign, randomUUID()])
      await request(app.server)
        .post(path(id))
        .set(owner.headers)
        .send({ assetIds: [] })
        .expect(404);
    await request(app.server)
      .post(path('invalid'))
      .set(owner.headers)
      .send(data)
      .expect(400);
    expect(await state()).toEqual(before);
    expect(reported).toEqual([]);
  });
  it('documents the canonical operation with an asset-array request and message/count response', () => {
    const doc = SwaggerModule.createDocument(
      app.app,
      new DocumentBuilder().build(),
    );
    expect(doc.paths['/api/projects/{id}/assets']?.post?.operationId).toBe(
      'ProjectsController_addAssets',
    );
    expect(doc.components?.schemas?.ProjectAssetsChangedDto).toMatchObject({
      type: 'object',
      properties: {
        message: { type: 'string' },
        count: { type: 'integer', minimum: 0 },
      },
      required: ['message', 'count'],
    });
  });
});
