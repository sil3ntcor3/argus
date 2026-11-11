import { VulnerabilityEvent } from '@/modules/vulnerabilities/entities/vulnerability-event.entity';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Finding dismissal and reopen history (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let ownAsset: string;
  let foreignAsset: string;

  async function insertId(sql: string, values: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(
      `${sql} RETURNING id`,
      values,
    );
    return row.id;
  }

  async function makeAsset(workspace: string) {
    const host = `${randomUUID()}.example.test`;
    const target = await insertId(
      'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,\'DOMAIN\',$2)',
      [host, workspace],
    );
    return insertId('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
      host,
      target,
    ]);
  }

  const finding = (asset = ownAsset) =>
    insertId(
      'INSERT INTO vulnerabilities (name,severity,"assetId") VALUES ($1,\'high\',$2)',
      [randomUUID(), asset],
    );
  const dismiss = (ids: string[], fields: Record<string, unknown>) =>
    request(app.server)
      .post('/api/vulnerabilities/dismiss')
      .set(owner.headers)
      .send({ ids, ...fields });
  const makeDismissal = (id: string, user = owner, expiresAt: Date | null = null) =>
    insertId(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason,"expiresAt")
       VALUES ($1,$2,$3,$4)`,
      [id, user.user.userId, expiresAt ? 'risk_accepted' : 'wont_fix', expiresAt],
    );
  const reopen = (ids: string[]) =>
    request(app.server)
      .post('/api/vulnerabilities/reopen')
      .set(owner.headers)
      .send({ ids });
  const eventsFor = (id: string) =>
    app.dataSource.getRepository(VulnerabilityEvent).find({
      where: { vulnerabilityId: id },
      order: { occurredAt: 'ASC', id: 'ASC' },
    });

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'dismissal-events-owner');
    other = await createUserWithWorkspace(app.server, 'dismissal-events-other');
    ownAsset = await makeAsset(owner.workspace.id);
    foreignAsset = await makeAsset(other.workspace.id);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
      });
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('writes one private event per distinct finding only after a successful dismissal', async () => {
    const id = await finding();
    const second = await finding();
    const foreign = await finding(foreignAsset);
    const fields = { reason: 'wont_fix', comment: 'Accepted internally' };

    await dismiss([id, foreign], fields).expect(404);
    expect(await eventsFor(id)).toHaveLength(0);
    expect(await eventsFor(foreign)).toHaveLength(0);
    await dismiss([id, second, id], fields).expect(201);
    await dismiss([id], fields).expect(400);

    for (const vulnerabilityId of [id, second]) {
      const events = await eventsFor(vulnerabilityId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workspaceId: owner.workspace.id,
        actorId: owner.user.userId,
        type: 'dismissed',
        data: { ...fields, expiresAt: null },
      });
      await request(app.server)
        .get(`/api/vulnerabilities/${vulnerabilityId}/timeline`)
        .set(owner.headers)
        .expect(200, {
          data: [
            {
              id: events[0].id,
              type: 'dismissed',
              occurredAt: events[0].occurredAt.toISOString(),
              fromStatus: null,
              toStatus: null,
              jobHistoryId: null,
              dismissalReason: fields.reason,
            },
          ],
        });
    }
  });

  it('orders expiry before replacement and records no event for a competing request', async () => {
    const id = await finding();
    await app.dataSource.query(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason,"expiresAt")
       VALUES ($1,$2,'risk_accepted',$3)`,
      [id, owner.user.userId, new Date(Date.now() - 86_400_000)],
    );
    const fields = {
      reason: 'risk_accepted',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const responses = await Promise.all([
      dismiss([id], fields),
      dismiss([id], fields),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 400]);
    const events = await eventsFor(id);
    expect(events.map(({ type }) => type)).toEqual(['risk_expired', 'dismissed']);
    expect(events[1].data).toMatchObject(fields);
  });

  it('reopens by dismissal ID, writes one event per finding, and keeps it private', async () => {
    const id = await finding();
    const second = await finding();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const ordinary = await makeDismissal(id);
    const timed = await makeDismissal(second, owner, expiresAt);
    const responses = await Promise.all([
      reopen([ordinary, timed, ordinary]),
      reopen([timed, ordinary]),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 404]);

    for (const [findingId, reason, expiry] of [
      [id, 'wont_fix', null],
      [second, 'risk_accepted', expiresAt.toISOString()],
    ] as const) {
      const events = await eventsFor(findingId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workspaceId: owner.workspace.id,
        actorId: owner.user.userId,
        type: 'reopened',
        data: { previousReason: reason },
      });
      const recordedExpiry = events[0].data?.expiresAt;
      expect(
        typeof recordedExpiry === 'string' ? new Date(recordedExpiry).toISOString() : recordedExpiry,
      ).toBe(expiry);
      await request(app.server)
        .get(`/api/vulnerabilities/${findingId}/timeline`)
        .set(owner.headers)
        .expect(200, {
          data: [
            {
              id: events[0].id,
              type: 'reopened',
              occurredAt: events[0].occurredAt.toISOString(),
              fromStatus: null,
              toStatus: null,
              jobHistoryId: null,
              dismissalReason: reason,
              ...(expiry ? { expiresAt: expiry } : {}),
            },
          ],
        });
    }
  });

  it('leaves both dismissals and histories untouched when a request includes a foreign ID', async () => {
    const id = await finding();
    const foreign = await finding(foreignAsset);
    const ownDismissal = await makeDismissal(id);
    const foreignDismissal = await makeDismissal(foreign, other);
    await reopen([ownDismissal, foreignDismissal]).expect(404);
    expect(await eventsFor(id)).toEqual([]);
    expect(await eventsFor(foreign)).toEqual([]);
    const { body } = await request(app.server)
      .get(`/api/vulnerabilities/${id}`)
      .set(owner.headers)
      .expect(200);
    expect(body).toMatchObject({ vulnerabilityDismissal: { id: ownDismissal } });
  });

  it('records expiry when a stale reopen removes an elapsed risk acceptance', async () => {
    const id = await finding();
    const elapsed = await makeDismissal(id, owner, new Date(Date.now() - 86_400_000));
    await reopen([elapsed]).expect(201);
    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'risk_expired',
      workspaceId: owner.workspace.id,
      actorId: null,
      data: { acceptedById: owner.user.userId },
    });
  });
});
