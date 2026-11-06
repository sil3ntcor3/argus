import { DataKind, TargetType, ToolCategory } from '@/common/enums/enum';
import { WORKER_TOKEN_HEADER } from '@/common/constants/app.constants';
import { JobsRegistryController } from '@/modules/jobs-registry/jobs-registry.controller';
import { JobsRegistryService } from '@/modules/jobs-registry/jobs-registry.service';
import { Job } from '@/modules/jobs-registry/entities/job.entity';
import { JobHistory } from '@/modules/jobs-registry/entities/job-history.entity';
import { Tool } from '@/modules/tools/entities/tools.entity';
import { WorkerStreamRegistry } from '@/modules/workers/worker-stream-registry.service';
import type { EntitySubscriberInterface } from 'typeorm';
import { StepScopeLoader } from '@/modules/jobs-registry/step-scope.loader';
import { planStepInputs } from '@/modules/jobs-registry/step-inputs';
import * as request from 'supertest';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

/** Real persistence, worker claims and existing REST privacy for input snapshots. */
describe('Job input foundation (e2e)', () => {
  jest.setTimeout(60_000);
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let other: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let assetId: string;
  let targetId: string;
  let toolId: string;
  let workerId: string;
  const workerToken = randomUUID();
  let runId: string;
  const host = 'job-inputs.example.com';
  const target = `https://${host}:8443`;

  /** Inserts fixture data without bypassing the application's schema migrations. */
  const insert = async (sql: string, values: unknown[]): Promise<string> => {
    const [row]: { id: string }[] = await app.dataSource.query(
      sql + ' RETURNING id',
      values,
    );
    return row.id;
  };

  /** Persists a pending connector job, leaving old-style inputs unset by default. */
  const job = (inputs?: Record<string, string>) =>
    app.dataSource.getRepository(Job).save({
      asset: { id: assetId },
      tool: { id: toolId },
      jobHistory: { id: runId },
      category: ToolCategory.VULNERABILITIES,
      inputs,
    });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'job-inputs-owner');
    other = await createUserWithWorkspace(app.server, 'job-inputs-other');
    targetId = await insert(
      `INSERT INTO targets (value, "workspaceId", type) VALUES ($1, $2, 'DOMAIN')`,
      [host, owner.workspace.id],
    );
    assetId = await insert(
      'INSERT INTO assets (value, "targetId") VALUES ($1, $2)',
      [host, targetId],
    );
    toolId = (
      await app.dataSource.query<{ id: string }[]>(
        `SELECT id FROM tools WHERE name = 'nuclei'`,
      )
    )[0].id;
    workerId = await insert(
      `INSERT INTO workers (name, "workspaceId", "runMode", token) VALUES ($1, $2, 'node', $3)`,
      ['Argus input validation worker', owner.workspace.id, workerToken],
    );
  });

  beforeEach(async () => {
    runId = await insert(
      `INSERT INTO job_histories ("jobHistoryName") VALUES ($1)`,
      ['Argus input validation'],
    );
  });

  afterEach(async () => {
    await app.dataSource.query('DELETE FROM job_histories WHERE id = $1', [
      runId,
    ]);
  });

  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('keeps snapshots nullable and out of normal entity reads and REST listings', async () => {
    const stored = await job({ target });
    const legacy = await job();
    const repo = app.dataSource.getRepository(Job);
    const normalRead = await repo.findOneByOrFail({ id: stored.id });
    expect(normalRead.inputs).toBeUndefined();
    expect(JSON.parse(JSON.stringify(normalRead))).not.toHaveProperty('inputs');
    const [row]: { inputs: unknown }[] = await app.dataSource.query(
      'SELECT inputs FROM jobs WHERE id = $1',
      [legacy.id],
    );
    expect(row.inputs).toBeNull();
    const response = await request(app.server)
      .get('/api/jobs-registry')
      .set(owner.headers)
      .expect(200);
    expect(JSON.stringify(response.body)).toContain(stored.id);
    expect(JSON.stringify(response.body)).not.toContain('"inputs"');
    expect(JSON.stringify(response.body)).not.toContain(target);
    await request(app.server)
      .get('/api/jobs-registry')
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(401);
    await request(app.server)
      .get('/api/jobs-registry')
      .set(other.headers)
      .set('X-Workspace-Id', owner.workspace.id)
      .expect(403);
  });

  it('loads each snapshot for a batched claim and dispatches legacy jobs by hostname', async () => {
    const stored = await job({ target });
    const legacy = await job();
    const controller = app.app.get(JobsRegistryController);
    const { values } = await controller.nextBatch({ id: workerId, limit: 2 });
    expect(values).toHaveLength(2);
    expect(values.find((value) => value.id === stored.id)?.inputs).toEqual({
      fields: { target: { stringValue: target } },
    });
    expect(values.find((value) => value.id === legacy.id)?.inputs).toEqual({
      fields: { target: { stringValue: host } },
    });
    expect(
      await app.app.get(JobsRegistryService).getNextJobs(workerId, 1),
    ).toEqual([]);
    const rows: { id: string; status: string; inputs: unknown }[] =
      await app.dataSource.query(
        'SELECT id, status, inputs FROM jobs WHERE "jobHistoryId" = $1',
        [runId],
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'in_progress')).toBe(true);
    expect(rows.find((row) => row.id === stored.id)?.inputs).toEqual({
      target,
    });
    expect(rows.find((row) => row.id === legacy.id)?.inputs).toBeNull();
  });

  it.each([undefined, { target }])(
    'preserves the HTTP claim contract with snapshot %j',
    async (inputs) => {
      const stored = await job(inputs);
      const response = await request(app.server)
        .get(`/api/jobs-registry/${workerId}/next`)
        .set(WORKER_TOKEN_HEADER, workerToken)
        .expect(200);
      expect(response.body.id).toBe(stored.id);
      expect(response.body).not.toHaveProperty('inputs');
      expect(JSON.stringify(response.body)).not.toContain(target);
    },
  );

  it('supports single-job claims without exposing snapshots to ordinary reads', async () => {
    const stored = await job({ target });
    const value = await app.app
      .get(JobsRegistryController)
      .next({ id: workerId });
    expect(value.id).toBe(stored.id);
    expect(value.inputs).toEqual({
      fields: { target: { stringValue: target } },
    });
    const normalRead = await app.dataSource
      .getRepository(Job)
      .findOneByOrFail({ id: stored.id });
    expect(normalRead.inputs).toBeUndefined();
  });

  it.each([
    ['microseconds', '2026-11-06 00:00:00.123455'],
    ['timestamp/UUID tie', '2026-11-06 00:00:00.123456'],
  ])(
    'retains an older eligible URL across a full excluded page (%s)',
    async (_, validTime) => {
      const serviceId = await insert(
        'INSERT INTO asset_services (value,port,"assetId") VALUES ($1,8443,$2) ON CONFLICT ("assetId",port) DO UPDATE SET value=EXCLUDED.value',
        [`${host}:8443`, assetId],
      );
      const prefix = randomUUID().slice(0, 24);
      await app.dataSource.query(
        `INSERT INTO discovered_urls (id,url,"assetServiceId","jobHistoryId","createdAt")
       SELECT ($1 || lpad(to_hex(i),12,'0'))::uuid,
         CASE WHEN i%3=0 THEN 'invalid-'||i
              WHEN i%3=1 THEN 'https://external.example.net/'||i
              ELSE 'ftp://'||$2||'/'||i END,
         $3::uuid,$4::uuid,$5::timestamp FROM generate_series(1,250) i`,
        [prefix, host, serviceId, runId, '2026-11-06 00:00:00.123456'],
      );
      const url = `https://${host}:8443/eligible`;
      await app.dataSource.query(
        'INSERT INTO discovered_urls (id,url,"assetServiceId","jobHistoryId","createdAt") VALUES ($1,$2,$3,$4,$5::timestamp)',
        [prefix + '000000000000', url, serviceId, runId, validTime],
      );
      const loader = new StepScopeLoader(app.dataSource);
      const filter = {
        workspaceId: owner.workspace.id,
        assetIds: [assetId],
        targetTypes: [TargetType.DOMAIN],
      };
      const loaded = await loader.load([DataKind.URL, DataKind.HOST], filter);
      expect(
        planStepInputs([DataKind.URL, DataKind.HOST], loaded.scope).map(
          (p) => p.connectorInputs,
        ),
      ).toEqual([{ target: url }]);
      expect(loaded.services.get(serviceId)?.id).toBe(serviceId);
      const foreign = await loader.load([DataKind.URL], {
        ...filter,
        workspaceId: other.workspace.id,
      });
      expect(foreign.scope.assets).toEqual([]);
    },
  );
  it.each(['assetIds', 'targetIds', 'assetServiceIds'] as const)(
    'loads a scope with more than 65,535 %s bindings',
    async (field) => {
      const serviceId = await insert(
        'INSERT INTO asset_services (value,port,"assetId") VALUES ($1,8443,$2) ON CONFLICT ("assetId",port) DO UPDATE SET value=EXCLUDED.value',
        [`${host}:8443`, assetId],
      );
      const id =
        field === 'assetIds'
          ? assetId
          : field === 'targetIds'
            ? targetId
            : serviceId;
      const loaded = await new StepScopeLoader(app.dataSource).load(
        [DataKind.SERVICE],
        {
          workspaceId: owner.workspace.id,
          targetTypes: [TargetType.DOMAIN],
          [field]: Array<string>(65_536).fill(id),
        },
      );
      expect(loaded.scope.assets.map((asset) => asset.id)).toEqual([assetId]);
      expect(
        loaded.scope.services?.get(assetId)?.map((service) => service.id),
      ).toContain(serviceId);
    },
  );

  it.each([
    { fail: false, count: 7000 },
    { fail: true, count: 600 },
  ])(
    'persists native job batches atomically (rollback=$fail)',
    async ({ fail, count }) => {
      const bulkTarget = await insert(
        `INSERT INTO targets (value,"workspaceId",type) VALUES ($1,$2,'DOMAIN')`,
        ['bulk-bindings.example.com', owner.workspace.id],
      );
      let bulkTool: string | undefined;
      let inserts = 0;
      const subscriber: EntitySubscriberInterface<Job> = {
        listenTo: () => Job,
        beforeInsert: () => {
          if (fail && ++inserts === 501)
            throw new Error('injected second chunk failure');
        },
      };
      app.dataSource.subscribers.push(subscriber);
      const hints = jest.spyOn(
        app.app.get(WorkerStreamRegistry),
        'publishJobsAvailable',
      );
      try {
        bulkTool = await insert(
          'INSERT INTO tools (name,categories) VALUES ($1,$2)',
          [
            `argus-bindings-${randomUUID()}`,
            JSON.stringify([
              {
                name: ToolCategory.PORTS_SCANNER,
                targetTypes: [TargetType.DOMAIN],
              },
            ]),
          ],
        );
        await app.dataSource.query(
          `INSERT INTO assets (value,"targetId") SELECT i||'.bulk-bindings.example.com',$1::uuid FROM generate_series(1,$2::int) i`,
          [bulkTarget, count],
        );
        const creating = app.app.get(JobsRegistryService).createNewJob({
          tool: await app.dataSource
            .getRepository(Tool)
            .findOneByOrFail({ id: bulkTool }),
          targetIds: [bulkTarget],
          workspaceId: owner.workspace.id,
          jobHistory: await app.dataSource
            .getRepository(JobHistory)
            .findOneByOrFail({ id: runId }),
        });
        if (fail) {
          await expect(creating).rejects.toThrow(
            'injected second chunk failure',
          );
          expect(hints).not.toHaveBeenCalled();
        } else {
          expect(await creating).toHaveLength(count);
          expect(hints).toHaveBeenCalledTimes(1);
          expect(hints).toHaveBeenCalledWith(owner.workspace.id);
        }
        expect(
          await app.dataSource
            .getRepository(Job)
            .countBy({ jobHistory: { id: runId } }),
        ).toBe(fail ? 0 : count);
      } finally {
        const index = app.dataSource.subscribers.indexOf(subscriber);
        if (index >= 0) app.dataSource.subscribers.splice(index, 1);
        hints.mockRestore();
        await app.dataSource.query('DELETE FROM targets WHERE id=$1', [
          bulkTarget,
        ]);
        if (bulkTool)
          await app.dataSource.query('DELETE FROM tools WHERE id=$1', [
            bulkTool,
          ]);
      }
    },
  );
});
