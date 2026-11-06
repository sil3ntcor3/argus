import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private project scope-rule foundation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let projectId: string, foreignId: string;
  const insert = async (
    project: string,
    mode: string,
    type: string,
    value: string,
  ) =>
    (
      await app.dataSource.query<Record<string, unknown>[]>(
        'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4) RETURNING *',
        [project, mode, type, value],
      )
    )[0];
  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'scope-foundation-owner');
    other = await createUserWithWorkspace(app.server, 'scope-foundation-other');
    for (const fixture of [owner, other]) {
      const [row]: { id: string }[] = await app.dataSource.query(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2) RETURNING id',
        [randomUUID(), fixture.workspace.id],
      );
      if (fixture === owner) projectId = row.id;
      else foreignId = row.id;
    }
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('roundtrips all upstream rule kinds with generated identity and timestamps', async () => {
    for (const [mode, type, value] of [
      ['include', 'target', randomUUID()],
      ['exclude', 'hostname', '*.argus.test'],
      ['include', 'cidr', '192.0.2.0/24'],
      ['include', 'asset', randomUUID()],
    ]) {
      const row = await insert(projectId, mode, type, value);
      expect(row).toMatchObject({ projectId, mode, type, value });
      expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    }
  });

  it('indexes the owning project and rejects a nonexistent project reference', async () => {
    await expect(
      insert(randomUUID(), 'include', 'hostname', '*.argus.test'),
    ).rejects.toMatchObject({ code: '23503' });
    const indexes = await app.dataSource.query<{ indexdef: string }[]>(
      'SELECT indexdef FROM pg_indexes WHERE tablename=$1 AND indexname=$2',
      ['project_scope_rules', 'IDX_psr_projectId'],
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('("projectId")');
  });

  it('keeps rules outside existing project/group responses and workspace access', async () => {
    for (const prefix of ['projects', 'asset-group']) {
      const response = await request(app.server)
        .get(`/api/${prefix}/${projectId}`)
        .set(owner.headers)
        .expect(200);
      expect(response.body).not.toHaveProperty('scopeRules');
      const list = await request(app.server)
        .get('/api/' + prefix)
        .set(owner.headers)
        .expect(200);
      expect(list.body.data[0]).not.toHaveProperty('scopeRules');
      await request(app.server)
        .get(`/api/${prefix}/${projectId}`)
        .set(other.headers)
        .expect(404);
    }
    const count = await app.dataSource.query(
      'SELECT id FROM project_scope_rules WHERE "projectId"=$1',
      [projectId],
    );
    expect(count).toHaveLength(4);
  });

  it('cascades project deletion without deleting rules belonging to another workspace', async () => {
    const foreign = await insert(
      foreignId,
      'include',
      'hostname',
      '*.other.argus.test',
    );
    await request(app.server)
      .delete('/api/projects/' + projectId)
      .set(owner.headers)
      .expect(200);
    expect(
      await app.dataSource.query(
        'SELECT id FROM project_scope_rules WHERE "projectId"=$1',
        [projectId],
      ),
    ).toEqual([]);
    expect(
      await app.dataSource.query(
        'SELECT id FROM project_scope_rules WHERE "projectId"=$1',
        [foreignId],
      ),
    ).toEqual([{ id: foreign.id }]);
  });
});
