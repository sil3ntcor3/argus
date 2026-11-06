import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import {
  cleanupE2eData,
  createUser,
  createUserWithWorkspace,
  type TestUser,
} from './helpers/workspace';
import * as request from 'supertest';

describe('Project permission compatibility (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let actor: TestUser;
  let roleId: string,
    recipientId: string,
    readId: string,
    writeId: string,
    projectId: string;
  const insert = async (sql: string, values: unknown[]): Promise<string> =>
    (
      await app.dataSource.query<{ id: string }[]>(
        sql + ' RETURNING id',
        values,
      )
    )[0].id;
  const permissions = (keys: string[]) =>
    app.dataSource.query(
      'UPDATE workspace_permissions SET permissions = $1 WHERE id = $2',
      [keys, roleId],
    );
  const headers = () => ({
    Cookie: actor.cookie,
    'X-Workspace-Id': owner.workspace.id,
  });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(
      app.server,
      'project-permission-owner',
    );
    other = await createUserWithWorkspace(
      app.server,
      'project-permission-other',
    );
    actor = await createUser(app.server);
    const member = await insert(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)',
      [owner.workspace.id, actor.userId],
    );
    recipientId = await insert(
      'INSERT INTO workspace_members ("workspaceId", "userId") VALUES ($1, $2)',
      [owner.workspace.id, other.user.userId],
    );
    const role = (name: string, keys: string[]) =>
      insert(
        'INSERT INTO workspace_permissions (name, permissions, "workspaceId") VALUES ($1, $2, $3)',
        [name, keys, owner.workspace.id],
      );
    roleId = await role('Actor', []);
    readId = await role('Legacy read', ['group.read']);
    writeId = await role('Project write', ['project.write']);
    await app.dataSource.query(
      'INSERT INTO workspace_member_permissions ("memberId", "permissionId") VALUES ($1, $2)',
      [member, roleId],
    );
    projectId = await insert(
      'INSERT INTO projects (name, "workspaceId") VALUES ($1, $2)',
      ['Argus permission project', owner.workspace.id],
    );
  });
  beforeEach(() => permissions([]));
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId, actor?.userId].filter(
        Boolean,
      ),
    });
    await closeTestApp(app.app);
  });

  it.each(['group.read', 'project.read', 'group.write', 'project.write'])(
    'keeps %s equivalent for access without changing the stored role',
    async (key) => {
      await permissions([key]);
      const current = await request(app.server)
        .get('/api/workspaces/current-permission')
        .set(headers())
        .expect(200);
      const action = key.split('.')[1];
      expect(current.body.currentPermission).toEqual(
        expect.arrayContaining([`group.${action}`, `project.${action}`]),
      );
      expect(current.body.currentPermission).toHaveLength(2);
      await request(app.server)
        .get(`/api/asset-group/${projectId}`)
        .set(headers())
        .expect(200);
      await request(app.server)
        .patch(`/api/asset-group/${projectId}`)
        .set(headers())
        .send({ name: 'Argus ' + key })
        .expect(action === 'write' ? 200 : 403);
      expect(
        await app.dataSource.query(
          'SELECT permissions FROM workspace_permissions WHERE id = $1',
          [roleId],
        ),
      ).toEqual([{ permissions: [key] }]);
    },
  );

  it('keeps authentication, workspace and unrelated resource boundaries', async () => {
    await permissions(['project.write']);
    await request(app.server).get(`/api/asset-group/${projectId}`).expect(401);
    await request(app.server)
      .get(`/api/asset-group/${projectId}`)
      .set(headers())
      .set('X-Workspace-Id', other.workspace.id)
      .expect(403);
    await permissions(['asset.read']);
    await request(app.server)
      .get(`/api/asset-group/${projectId}`)
      .set(headers())
      .expect(403);
  });

  it('publishes canonical actions while keeping legacy keys selectable', async () => {
    const response = await request(app.server)
      .get('/api/workspaces/permissions/catalog')
      .set(owner.headers)
      .expect(200);
    for (const resource of ['project', 'group']) {
      expect(
        response.body.find(
          (item: { resource: string }) => item.resource === resource,
        )?.actions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'read' }),
          expect.objectContaining({ action: 'write' }),
        ]),
      );
    }
  });

  it('allows exact alias delegation while preserving strict action grants', async () => {
    await permissions(['workspace.write', 'project.read']);
    const response = await request(app.server)
      .post('/api/workspaces/permissions')
      .set(headers())
      .send({ name: 'Equivalent legacy reader', permissions: ['group.read'] })
      .expect(201);
    await request(app.server)
      .patch(`/api/workspaces/permissions/${response.body.id}`)
      .set(headers())
      .send({ permissions: ['group.write'] })
      .expect(400);
    await permissions(['workspace.write', 'group.write']);
    await request(app.server)
      .post('/api/workspaces/permissions')
      .set(headers())
      .send({
        name: 'Equivalent project writer',
        permissions: ['project.write'],
      })
      .expect(201);
    await request(app.server)
      .post('/api/workspaces/permissions')
      .set(headers())
      .send({
        name: 'Implicit read grant forbidden',
        permissions: ['project.read'],
      })
      .expect(400);
  });

  it('checks aliases when assigning whole groups and rejects stronger assignments', async () => {
    await permissions(['member.write', 'project.read']);
    await request(app.server)
      .patch(`/api/workspaces/members/${recipientId}`)
      .set(headers())
      .send({ permissionIds: [readId] })
      .expect(200);
    await request(app.server)
      .patch(`/api/workspaces/members/${recipientId}`)
      .set(headers())
      .send({ permissionIds: [writeId] })
      .expect(400);
    expect(
      await app.dataSource.query(
        'SELECT "permissionId" FROM workspace_member_permissions WHERE "memberId" = $1',
        [recipientId],
      ),
    ).toEqual([{ permissionId: readId }]);
  });
});
