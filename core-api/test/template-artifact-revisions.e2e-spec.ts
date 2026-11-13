import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Template artifact revision storage (e2e)', () => {
  let app: TestApp;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
  });
  beforeEach(async () => {
    const [workspace] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id', ['Template constraints ' + randomUUID()],
    );
    workspaceId = workspace.id;
  });
  afterEach(async () => {
    if (workspaceId) await app.dataSource.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });
  afterAll(async () => {
    if (app) await closeTestApp(app.app);
  });

  async function insert(source: string, objectKey: (id: string) => string) {
    const id = randomUUID();
    return app.dataSource.query<{ id: string; objectKey: string; source: string }[]>(
      `INSERT INTO artifacts (id,"workspaceId",name,"mimeType","objectKey","sizeBytes",source,status)
       VALUES ($1,$2,'check.yaml','application/yaml',$3,10,$4,'ready')
       RETURNING id,"objectKey",source`,
      [id, workspaceId, objectKey(id), source],
    );
  }

  it('accepts stable final keys for existing sources and templates', async () => {
    for (const source of ['upload', 'agent', 'template']) {
      const rows = await insert(source, id => `workspaces/${workspaceId}/${id}/file`);
      expect(rows).toEqual([expect.objectContaining({ source })]);
    }
  });

  it('accepts a server-generated immutable revision only for a template', async () => {
    const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const rows = await insert('template', id => `workspaces/${workspaceId}/${id}/revisions/${revision}`);
    expect(rows[0].objectKey).toBe(`workspaces/${workspaceId}/${rows[0].id}/revisions/${revision}`);
    for (const source of ['upload', 'agent']) {
      await expect(insert(source, id => `workspaces/${workspaceId}/${id}/revisions/${revision}`))
        .rejects.toMatchObject({ code: '23514', constraint: 'CHK_artifacts_object_key_revisions' });
    }
  });

  it('rejects foreign namespaces, traversal, trailing paths and arbitrary revisions', async () => {
    const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const keys: Array<(id: string) => string> = [
      id => `workspaces/${randomUUID()}/${id}/revisions/${revision}`,
      () => `workspaces/${workspaceId}/${randomUUID()}/revisions/${revision}`,
      id => `workspaces/${workspaceId}/${id}/revisions/../file`,
      id => `workspaces/${workspaceId}/${id}/revisions/${revision}/extra`,
      id => `workspaces/${workspaceId}/${id}/revisions/display-name.yaml`,
      id => `workspaces/${workspaceId}/${id}/revisions/${revision}\n`,
      id => `workspaces/${workspaceId}/${id}/revisions/${revision.toUpperCase()}`,
    ];
    for (const objectKey of keys) {
      await expect(insert('template', objectKey))
        .rejects.toMatchObject({ code: '23514', constraint: 'CHK_artifacts_object_key_revisions' });
    }
    await expect(insert('unknown', id => `workspaces/${workspaceId}/${id}/file`))
      .rejects.toMatchObject({ code: '23514', constraint: 'CHK_artifacts_source_templates' });
  });
});
