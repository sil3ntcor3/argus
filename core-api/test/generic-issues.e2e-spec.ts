import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Generic Issues (Docker HTTP)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: typeof owner;
  let asset: string;
  const standaloneRuns: string[] = [];
  const create = (body: object) => request(app.server).post('/api/issues').set(owner.headers).send(body);
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0, '127.0.0.1');
    owner = await createUserWithWorkspace(app.server, 'generic-issues');
    other = await createUserWithWorkspace(app.server, 'generic-issues-foreign');
    const [target] = await app.dataSource.query('INSERT INTO targets(value,type,"workspaceId") VALUES($1,$2,$3) RETURNING id', ['issues.example.test', 'DOMAIN', owner.workspace.id]);
    [asset] = (await app.dataSource.query('INSERT INTO assets(value,"targetId") VALUES($1,$2) RETURNING id', ['issues.example.test', target.id])).map((row: { id: string }) => row.id);
  });
  afterAll(async () => {
    if (standaloneRuns.length) await app.dataSource.query('DELETE FROM job_histories WHERE id=ANY($1::uuid[])', [standaloneRuns]);
    if (app) await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean), userIds: [owner?.user.userId, other?.user.userId].filter(Boolean) });
    await closeTestApp(app?.app);
  });

  it('creates numbered work items, updates their properties and returns safe user projections', async () => {
    const created = await create({ title: 'Review staging asset', type: 'asset_review', priority: 'p2', assigneeId: owner.user.userId, links: [{ resourceType: 'asset', resourceId: asset }] }).expect(201);
    expect(created.body).toMatchObject({ title: 'Review staging asset', type: 'asset_review', status: 'open', priority: 'p2', linkCount: 1, assignee: { id: owner.user.userId } });
    expect(created.body.no).toBeGreaterThan(0);
    expect(Object.keys(created.body.assignee).sort()).toEqual(['id', 'image', 'name']);
    const updated = await request(app.server).patch(`/api/issues/${created.body.id}`).set(owner.headers).send({ title: 'Updated asset work', priority: 'p1', assigneeId: null, tags: ['staging'], dueAt: '2030-01-01T00:00:00Z' }).expect(200);
    expect(updated.body).toMatchObject({ title: 'Updated asset work', priority: 'p1', assignee: null, tags: ['staging'] });
    await request(app.server).get(`/api/issues/${created.body.id}`).set(other.headers).expect(404);
  });

  it('serializes concurrent numbers and never reuses a deleted issue number', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => create({ title: `Concurrent work ${index}` })));
    expect(responses.map(row => row.status)).toEqual(Array(8).fill(201));
    const numbers = responses.map(row => row.body.no as number);
    expect(new Set(numbers).size).toBe(8);
    const latest = responses.find(row => row.body.no === Math.max(...numbers))!;
    await request(app.server).delete(`/api/issues/${latest.body.id}`).set(owner.headers).expect(200);
    const next = await create({ title: 'After deletion' }).expect(201);
    expect(next.body.no).toBeGreaterThan(Math.max(...numbers));
  });

  it('requires a resolution for final states and writes immutable same-thread system activity', async () => {
    const created = await create({ title: 'Resolve this work' }).expect(201);
    const path = `/api/issues/${created.body.id}`;
    await request(app.server).patch(path + '/status').set(owner.headers).send({ status: 'resolved' }).expect(400);
    await request(app.server).patch(path + '/status').set(owner.headers).send({ status: 'resolved', resolution: 'fixed', note: 'Rechecked locally' }).expect(200);
    const comments = await request(app.server).get(path + '/comments').set(owner.headers).expect(200);
    expect(comments.body.data).toHaveLength(1);
    expect(comments.body.data[0]).toMatchObject({ isCanEdit: false, isCanDelete: false });
    await request(app.server).patch(path + '/status').set(owner.headers).send({ status: 'in_progress' }).expect(200);
    const reopened = await request(app.server).get(path).set(owner.headers).expect(200);
    expect(reopened.body).toMatchObject({ status: 'in_progress', resolution: null, resolvedAt: null });
  });

  it('deduplicates valid links, scopes assignees and refuses foreign resources', async () => {
    const created = await create({ title: 'Linked work' }).expect(201);
    const path = `/api/issues/${created.body.id}`;
    const link = { resourceType: 'asset', resourceId: asset };
    const linked = await request(app.server).post(path + '/links').set(owner.headers).send({ links: [link, link] }).expect(201);
    expect(linked.body.links).toHaveLength(1);
    await request(app.server).post(path + '/links').set(owner.headers).send({ links: [{ resourceType: 'asset', resourceId: randomUUID() }] }).expect(404);
    await request(app.server).patch(path).set(owner.headers).send({ assigneeId: other.user.userId }).expect(400);
    await request(app.server).delete(path + '/links/' + linked.body.links[0].id).set(owner.headers).expect(200);
    expect((await request(app.server).get(path).set(owner.headers).expect(200)).body.links).toEqual([]);
  });

  it('lists and filters workspace work without exposing another workspace', async () => {
    const created = await create({ title: 'Filter sentinel', type: 'task', priority: 'p4', assigneeId: owner.user.userId }).expect(201);
    const list = await request(app.server).get('/api/issues').query({ search: '#' + created.body.no, mine: true, priority: 'p4', status: 'open' }).set(owner.headers).expect(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([created.body.id]);
    await request(app.server).get('/api/issues').query({ status: 'bad' }).set(owner.headers).expect(400);
    await request(app.server).get('/api/issues').expect(401);
  });

  it('installs defaults once and validates workspace-scoped rule edits', async () => {
    const first = await request(app.server).post('/api/issues/rules/defaults').set(owner.headers).send({}).expect(201);
    const second = await request(app.server).post('/api/issues/rules/defaults').set(owner.headers).send({}).expect(201);
    expect(second.body.map((row: { id: string }) => row.id)).toEqual(first.body.map((row: { id: string }) => row.id));
    expect(first.body).toHaveLength(1);
    const rule = first.body[0];
    await request(app.server).patch(`/api/issues/rules/${rule.id}`).set(other.headers).send({ enabled: false }).expect(404);
    await request(app.server).patch(`/api/issues/rules/${rule.id}`).set(owner.headers).send({ conditions: { minEpss: 2 } }).expect(400);
    await request(app.server).patch(`/api/issues/rules/${rule.id}`).set(owner.headers).send({ enabled: false }).expect(200);
    await request(app.server).delete(`/api/issues/rules/${rule.id}`).set(owner.headers).expect(200);
  });

  it('does not expose linked finding details or progress to workspace-only readers', async () => {
    const [finding] = await app.dataSource.query('INSERT INTO vulnerabilities(name,fingerprint,"assetId",severity) VALUES($1,$2,$3,$4) RETURNING id', ['Restricted finding sentinel', randomUUID(), asset, 'critical']);
    const created = await create({ title: 'Restricted resource work', type: 'vulnerability_remediation', links: [{ resourceType: 'vulnerability', resourceId: finding.id }] }).expect(201);
    const [member] = await app.dataSource.query('INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2) RETURNING id', [owner.workspace.id, other.user.userId]);
    const [role] = await app.dataSource.query('INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3) RETURNING id', [owner.workspace.id, 'Work items only', ['workspace.read', 'workspace.write']]);
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member.id, role.id]);
    const headers = { ...other.headers, 'X-Workspace-Id': owner.workspace.id };
    const detail = await request(app.server).get(`/api/issues/${created.body.id}`).set(headers).expect(200);
    expect(detail.body.links).toEqual([]);
    expect(detail.body.progress).toBeNull();
    expect(JSON.stringify(detail.body)).not.toContain('Restricted finding sentinel');
    await request(app.server).get('/api/issues').query({ resourceType: 'vulnerability', resourceId: finding.id }).set(headers).expect(403);
    await request(app.server).post(`/api/issues/${created.body.id}/links`).set(headers).send({ links: [{ resourceType: 'vulnerability', resourceId: finding.id }] }).expect(403);
  });

  it('rejects blank names and invalid null fields without database errors', async () => {
    await create({ title: '   ' }).expect(400);
    const issue = await create({ title: 'Valid work' }).expect(201);
    for (const body of [{ title: null }, { title: '  ' }, { priority: null }, { tags: null }]) {
      await request(app.server).patch(`/api/issues/${issue.body.id}`).set(owner.headers).send(body).expect(400);
    }
    const rule = { name: 'Rule', event: 'vulnerability.detected', issueType: 'vulnerability_remediation' };
    await request(app.server).post('/api/issues/rules').set(owner.headers).send({ ...rule, name: '  ' }).expect(400);
    for (const conditions of [[], [{ minSeverity: 'high' }]]) await request(app.server).post('/api/issues/rules').set(owner.headers).send({ ...rule, conditions }).expect(400);
    const created = await request(app.server).post('/api/issues/rules').set(owner.headers).send(rule).expect(201);
    for (const body of [{ enabled: null }, { name: null }, { conditions: null }, { conditions: [] }, { conditions: [{ minSeverity: 'high' }] }, { groupBy: null }, { event: null }]) {
      await request(app.server).patch(`/api/issues/rules/${created.body.id}`).set(owner.headers).send(body).expect(400);
    }
  });

  it('shows scoped issue references on findings and target overview', async () => {
    const [finding] = await app.dataSource.query('INSERT INTO vulnerabilities(name,fingerprint,"assetId",severity) VALUES($1,$2,$3,$4) RETURNING id', ['Issue reference sentinel', randomUUID(), asset, 'high']);
    const created = await create({ title: 'Reference work', links: [{ resourceType: 'vulnerability', resourceId: finding.id }] }).expect(201);
    const detail = await request(app.server).get(`/api/vulnerabilities/${finding.id}`).set(owner.headers).expect(200);
    expect(detail.body.openIssue).toEqual({ id: created.body.id, no: created.body.no, status: 'open' });
    const [{ targetId }] = await app.dataSource.query('SELECT "targetId" FROM assets WHERE id=$1', [asset]);
    const overview = await request(app.server).get(`/api/targets/${targetId}/overview`).set(owner.headers).expect(200);
    expect(overview.body.issues.map((row: { id: string }) => row.id)).toContain(created.body.id);
    await request(app.server).patch(`/api/issues/${created.body.id}/status`).set(owner.headers).send({ status: 'closed', resolution: 'other' }).expect(200);
    expect((await request(app.server).get(`/api/vulnerabilities/${finding.id}`).set(owner.headers).expect(200)).body.openIssue).toBeNull();
  });
  it('serializes concurrent field/status edits and never resurrects deleted issues or rules', async () => {
    const issue = (await create({ title: 'Concurrent decisions' }).expect(201)).body;
    const path = '/api/issues/' + issue.id;
    const queued = async (first: () => Promise<unknown>, second: () => Promise<unknown>) => {
      const runner = app.dataSource.createQueryRunner(); await runner.connect(); await runner.startTransaction();
      await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['issues:' + owner.workspace.id]);
      const waiting = async (count: number) => {
        for (let n=0;n<100;n++) {
          const [row] = await app.dataSource.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`);
          if (row.count>=count) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Expected queued issue writer');
      };
      try {
        const a = first(); await waiting(1); const b = second(); await waiting(2);
        await runner.commitTransaction(); return await Promise.all([a,b]);
      } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    };
    await queued(() => request(app.server).patch(path).set(owner.headers).send({ title: 'Retained title' }).then(response => expect(response.status).toBe(200)),
      () => request(app.server).patch(path + '/status').set(owner.headers).send({ status: 'in_progress' }).then(response => expect(response.status).toBe(200)));
    expect((await request(app.server).get(path).set(owner.headers).expect(200)).body).toMatchObject({ title: 'Retained title', status: 'in_progress' });
    await queued(() => request(app.server).delete(path).set(owner.headers).then(response => expect(response.status).toBe(200)),
      () => request(app.server).patch(path).set(owner.headers).send({ title: 'Must not return' }).then(response => expect(response.status).toBe(404)));
    await request(app.server).get(path).set(owner.headers).expect(404);
    const rule = (await request(app.server).post('/api/issues/rules').set(owner.headers).send({ name: 'Queued rule', event: 'vulnerability.detected', issueType: 'vulnerability_remediation' }).expect(201)).body;
    const rulePath = '/api/issues/rules/' + rule.id;
    await queued(() => request(app.server).patch(rulePath).set(owner.headers).send({ enabled: false }).then(response => expect(response.status).toBe(200)),
      () => request(app.server).patch(rulePath).set(owner.headers).send({ name: 'Retained disabled rule' }).then(response => expect(response.status).toBe(200)));
    expect((await request(app.server).get('/api/issues/rules').set(owner.headers).expect(200)).body.find((row: { id: string }) => row.id===rule.id)).toMatchObject({ enabled: false, name: 'Retained disabled rule' });
    await queued(() => request(app.server).delete(rulePath).set(owner.headers).then(response => expect(response.status).toBe(200)),
      () => request(app.server).patch(rulePath).set(owner.headers).send({ enabled: true }).then(response => expect(response.status).toBe(404)));
  });

  it('accepts owned standalone run links and rejects mixed or orphaned run provenance', async () => {
    const [foreignTarget]=await app.dataSource.query(`INSERT INTO targets(value,type,"workspaceId") VALUES($1,'DOMAIN',$2) RETURNING id`,[randomUUID()+'.example.test',other.workspace.id]);
    const [foreignAsset]=await app.dataSource.query('INSERT INTO assets(value,"targetId") VALUES($1,$2) RETURNING id',[randomUUID(),foreignTarget.id]);
    const runs: string[]=[];
    for (const assets of [[asset],[asset,foreignAsset.id],[asset,null]]) {
      const [run]=await app.dataSource.query('INSERT INTO job_histories DEFAULT VALUES RETURNING id');runs.push(run.id);standaloneRuns.push(run.id);
      for(const linked of assets)await app.dataSource.query(`INSERT INTO jobs("jobHistoryId","assetId",category) VALUES($1,$2,'vulnerabilities')`,[run.id,linked]);
    }
    const issue=await create({ title:'Standalone run references' }).expect(201);
    const path='/api/issues/'+issue.body.id+'/links';
    await request(app.server).post(path).set(owner.headers).send({ links:[{ resourceType:'job_history',resourceId:runs[0] }] }).expect(201);
    for(const id of runs.slice(1))await request(app.server).post(path).set(owner.headers).send({ links:[{ resourceType:'job_history',resourceId:id }] }).expect(404);
  });

});
