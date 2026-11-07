import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project workflow templates API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    reader: typeof owner;
  let role: string;
  const ids: string[] = [];
  const prefix = randomUUID();
  const url = '/api/projects/workflow-templates';
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'template-owner');
    reader = await createUserWithWorkspace(app.server, 'template-reader');
    for (const [name, workspace, editable] of [
      ['B', owner.workspace.id, false],
      ['A', owner.workspace.id, false],
      ['A', reader.workspace.id, false],
      ['Editable', owner.workspace.id, true],
    ] as const)
      ids.push(
        await insert(
          'INSERT INTO workflows (name,content,"filePath","workspaceId","isCanEdit") VALUES ($1,$2,$3,$4,$5)',
          [
            prefix + ' ' + name,
            JSON.stringify({
              name: 'Argus template',
              jobs: {
                probe: { run: 'httpx', config: { token: 'secret' } },
                scan: {
                  run: 'nuclei',
                  needs: 'probe',
                  configProfileId: randomUUID(),
                },
              },
            }),
            prefix + '-' + ids.length + '.yaml',
            workspace,
            editable,
          ],
        ),
      );
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId","userId") VALUES ($1,$2)',
      [owner.workspace.id, reader.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions (name,permissions,"workspaceId") VALUES ($1,$2,$3)',
      [randomUUID(), ['project.read'], owner.workspace.id],
    );
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId","permissionId") VALUES ($1,$2)',
      [member, role],
    );
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('matches the static route and returns only owned defaults in stable name order', async () => {
    const before = await app.dataSource.query(
      'SELECT * FROM workflows WHERE id=ANY($1::uuid[]) ORDER BY id',
      [ids],
    );
    const result = await request(app.server)
      .get(url)
      .set(owner.headers)
      .expect(200);
    const fixtures = result.body.filter((w: { filePath: string }) =>
      w.filePath.startsWith(prefix),
    );
    // JSONB object keys are unordered; dependencies identify the graph edges.
    for (const workflow of fixtures as { jobs: { id: string }[] }[])
      workflow.jobs.sort((a, b) => a.id.localeCompare(b.id));
    expect(fixtures).toEqual(
      [1, 0].map((i) => ({
        filePath: prefix + '-' + i + '.yaml',
        name: prefix + ' ' + (i ? 'A' : 'B'),
        jobs: [
          { id: 'probe', run: 'httpx', needs: [] },
          { id: 'scan', run: 'nuclei', needs: ['probe'] },
        ],
      })),
    );
    expect(
      await app.dataSource.query(
        'SELECT * FROM workflows WHERE id=ANY($1::uuid[]) ORDER BY id',
        [ids],
      ),
    ).toEqual(before);
    const other = await request(app.server)
      .get(url)
      .set(reader.headers)
      .expect(200);
    expect(
      other.body.filter((w: { filePath: string }) =>
        w.filePath.startsWith(prefix),
      ),
    ).toEqual([expect.objectContaining({ filePath: prefix + '-2.yaml' })]);
  });
  it('accepts both read aliases and denies missing permissions, nonmembers and anonymous requests', async () => {
    const headers = { ...reader.headers, 'X-Workspace-Id': owner.workspace.id };
    for (const permission of ['project.read', 'group.read']) {
      await app.dataSource.query(
        'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
        [[permission], role],
      );
      await request(app.server).get(url).set(headers).expect(200);
    }
    await app.dataSource.query(
      'UPDATE workspace_permissions SET permissions=$1 WHERE id=$2',
      [[], role],
    );
    await request(app.server).get(url).set(headers).expect(403);
    await request(app.server)
      .get(url)
      .set({ ...owner.headers, 'X-Workspace-Id': reader.workspace.id })
      .expect(403);
    await request(app.server)
      .get(url)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
  });
  it('returns an empty array when no immutable templates exist and leaves legacy routes intact', async () => {
    const saved = await app.dataSource.query<{ id: string }[]>(
      'SELECT id FROM workflows WHERE "workspaceId"=$1 AND "isCanEdit"=false',
      [reader.workspace.id],
    );
    await app.dataSource.query(
      'UPDATE workflows SET "isCanEdit"=true WHERE id=ANY($1::uuid[])',
      [saved.map((w) => w.id)],
    );
    try {
      expect(
        (await request(app.server).get(url).set(reader.headers).expect(200))
          .body,
      ).toEqual([]);
    } finally {
      await app.dataSource.query(
        'UPDATE workflows SET "isCanEdit"=false WHERE id=ANY($1::uuid[])',
        [saved.map((w) => w.id)],
      );
    }
    await request(app.server)
      .get('/api/projects/' + randomUUID())
      .set(owner.headers)
      .expect(404);
    await request(app.server)
      .get('/api/workflows/templates')
      .set(owner.headers)
      .expect(200);
  });
});
