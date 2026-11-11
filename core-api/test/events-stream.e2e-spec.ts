import { WorkspacesService } from '@/modules/workspaces/workspaces.service';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUser, type TestUser } from './helpers/workspace';

describe('Live events stream', () => {
  let app: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    app = await createTestApp();
    user = await createUser(app.server);
  });

  afterAll(async () => {
    if (!app) return;
    if (user) await cleanupE2eData(app.dataSource, { userIds: [user.userId] });
    await closeTestApp(app.app);
  });

  it('returns HTTP 403 when the membership lookup finishes after SSE setup could send headers', async () => {
    const membership = jest
      .spyOn(app.app.get(WorkspacesService), 'getMembershipWithPermissions')
      .mockImplementationOnce(async () => {
        await setTimeout(25);
        throw new NotFoundException();
      });
    const workspaceId = randomUUID();

    try {
      await request(app.server)
        .get('/api/events/stream')
        .set('Cookie', user.cookie)
        .set('X-Workspace-Id', workspaceId)
        .set('Accept', 'text/event-stream')
        .expect(403)
        .expect('Content-Type', /application\/json/);
      expect(membership).toHaveBeenCalledWith(workspaceId, user.userId);
    } finally {
      membership.mockRestore();
    }
  });
});
