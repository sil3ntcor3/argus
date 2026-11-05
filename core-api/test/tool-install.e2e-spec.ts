import { Tool } from '@/modules/tools/entities/tools.entity';
import { WorkspaceTool } from '@/modules/tools/entities/workspace_tools.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Validate installation errors and tenant boundaries against local Postgres. */
describe('Tool installation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let toolId: string;
  const missing = randomUUID();

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'tool-install-owner');
    other = await createUserWithWorkspace(app.server, 'tool-install-other');
    toolId = (
      await app.dataSource
        .getRepository(Tool)
        .findOneByOrFail({ name: 'nuclei' })
    ).id!;
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
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
    expect(first.body.tool).toEqual({ id: toolId });
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
});
