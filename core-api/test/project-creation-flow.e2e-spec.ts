import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import * as request from 'supertest';
import { Workflow } from '@/modules/workflows/entities/workflow.entity';
import { ProjectWorkflowActionsService } from '@/modules/projects/project-workflow-actions.service';
import { ProjectTriggerRuntimeService } from '@/modules/projects/project-trigger-runtime.service';
import { ConnectorRegistryService } from '@/modules/connectors/connector-registry.service';
import { WorkspaceEncryptionService } from '@/services/workspace-encryption/workspace-encryption.service';
import { decryptInlineConfig } from '@/modules/tools/validators/tool-config-profiles.crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Combined project creation (Docker)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let role: string, localAsset: string, foreignAsset: string, target: string;
  const template = randomUUID() + '.yaml';
  const jobs = { probe: { run: 'subfinder' } };
  const query = (sql: string, args: unknown[] = []) =>
    app.dataSource.query<Record<string, any>[]>(sql, args);
  const insert = async (sql: string, args: unknown[]) =>
    (await query(sql + ' RETURNING id', args))[0].id as string;
  const post = (body: object, headers = owner.headers) =>
    request(app.server).post('/api/projects').set(headers).send(body);
  const reader = () => ({
    ...other.headers,
    'X-Workspace-Id': owner.workspace.id,
  });
  const name = () => 'Creation ' + randomUUID();
  const counts = async () =>
    (
      await query(
        `SELECT
    (SELECT count(*)::int FROM projects WHERE "workspaceId"=$1) projects,
    (SELECT count(*)::int FROM workflows WHERE "workspaceId"=$1) workflows,
    (SELECT count(*)::int FROM project_workflows pw JOIN projects p ON p.id=pw."projectId" WHERE p."workspaceId"=$1) bindings,
    (SELECT count(*)::int FROM project_scope_rules r JOIN projects p ON p.id=r."projectId" WHERE p."workspaceId"=$1) rules,
    (SELECT count(*)::int FROM project_workflow_triggers tr JOIN project_workflows pw ON pw.id=tr."projectWorkflowId" JOIN projects p ON p.id=pw."projectId" WHERE p."workspaceId"=$1) triggers`,
        [owner.workspace.id],
      )
    )[0];
  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'creation-owner');
    other = await createUserWithWorkspace(app.server, 'creation-other');
    const member = await insert(
      'INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2)',
      [owner.workspace.id, other.user.userId],
    );
    role = await insert(
      'INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3)',
      [owner.workspace.id, randomUUID(), ['project.write']],
    );
    await query(
      'INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)',
      [member, role],
    );
    target = await insert(
      'INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)',
      [randomUUID() + '.example.test', owner.workspace.id],
    );
    localAsset = await insert(
      'INSERT INTO assets(value,"targetId","isPrimary") VALUES($1,$2,true)',
      ['creation.example.test', target],
    );
    const foreignTarget = await insert(
      'INSERT INTO targets(value,type,"workspaceId") VALUES($1,\'DOMAIN\',$2)',
      [randomUUID() + '.example.test', other.workspace.id],
    );
    foreignAsset = await insert(
      'INSERT INTO assets(value,"targetId") VALUES($1,$2)',
      ['foreign.example.test', foreignTarget],
    );
    for (const workspaceId of [owner.workspace.id, other.workspace.id])
      await query(
        'INSERT INTO workflows(name,"filePath",content,"workspaceId","isCanEdit") VALUES($1,$2,$3,$4,false)',
        [
          'Default creation scan',
          template,
          {
            name: 'Default creation scan',
            jobs,
            on: { schedule: '0 0 * * *', target: ['domain.create'] },
          },
          workspaceId,
        ],
      );
  });
  beforeEach(async () => {
    await query('UPDATE workspace_permissions SET permissions=$1 WHERE id=$2', [
      ['project.write'],
      role,
    ]);
  });
  afterAll(async () => {
    try {
      if (app)
        await cleanupE2eData(app.dataSource, {
          workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(
            Boolean,
          ),
          userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
        });
    } finally {
      await closeTestApp(app?.app);
    }
  });

  it('retains the legacy create receipt without adding creation outcomes', async () => {
    const result = await post({ name: name(), hostIds: [localAsset] }).expect(
      201,
    );
    expect(result.body.totalAssets).toBe(1);
    expect(result.body).not.toHaveProperty('creation');
  });
  it('keeps the legacy tool schedule default and explicit on precedence for enriched calls', async () => {
    const [tool] = await query('SELECT id FROM tools WHERE name=$1', [
      'subfinder',
    ]);
    const legacy = await post({ name: name(), toolIds: [tool.id] }).expect(201);
    expect(legacy.body).not.toHaveProperty('creation');
    const [binding] = await query(
      'SELECT schedule FROM project_workflows WHERE "projectId"=$1',
      [legacy.body.id],
    );
    expect(binding.schedule).toBe('0 0 */3 * *');
    const enriched = await post(
      {
        name: name(),
        jobs,
        schedule: '0 9 * * *',
        on: { schedule: [], events: [] },
      },
      reader(),
    ).expect(201);
    expect(
      (
        await query(
          'SELECT schedule FROM project_workflows WHERE "projectId"=$1',
          [enriched.body.id],
        )
      )[0].schedule,
    ).toBe('disabled');
  });
  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects raw own on.%s before Nest strips it',
    async (key) => {
      const before = await counts();
      await request(app.server)
        .post('/api/projects')
        .set(owner.headers)
        .type('json')
        .send(
          JSON.stringify({
            name: name(),
            jobs,
            on: JSON.parse(`{"${key}":{}}`),
          }),
        )
        .expect(400);
      expect(await counts()).toEqual(before);
    },
  );

  it('creates scope, an owned template pipeline and disabled trigger definitions together', async () => {
    const result = await post({
      name: name(),
      hostIds: [localAsset],
      scopeRules: [{ mode: 'include', type: 'target', value: target }],
      template,
      workflowName: 'Initial Argus scan',
      on: {
        schedule: [{ cron: '0 8 * * *' }],
        events: [{ event: 'project.assets.added', enabled: false }],
      },
    }).expect(201);
    expect(result.body).toMatchObject({
      totalAssets: 1,
      creation: { triggerSync: 'complete' },
    });
    const [saved] = await query(
      `SELECT w.name,w.content,pw.schedule FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw."projectId"=$1`,
      [result.body.id],
    );
    expect(saved).toMatchObject({
      name: 'Initial Argus scan',
      schedule: 'disabled',
      content: { jobs },
    });
    expect(saved.content.on).not.toHaveProperty('target');
    const triggers = (
      await request(app.server)
        .get(`/api/projects/${result.body.id}/triggers`)
        .set(owner.headers)
        .expect(200)
    ).body;
    expect(triggers).toHaveLength(2);
    expect(triggers.every((tr: { enabled: boolean }) => !tr.enabled)).toBe(
      true,
    );
    expect(
      (
        await query('SELECT source FROM project_assets WHERE "projectId"=$1', [
          result.body.id,
        ])
      )[0].source,
    ).toBe('manual');
  });
  it('creates selected jobs without implicit legacy scheduling', async () => {
    const result = await post({
      name: name(),
      jobs,
      on: { schedule: [], events: [] },
    }).expect(201);
    const [saved] = await query(
      `SELECT w.content,pw.schedule FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw."projectId"=$1`,
      [result.body.id],
    );
    expect(saved).toMatchObject({ content: { jobs }, schedule: 'disabled' });
    expect(saved.content.on).toBeUndefined();
  });
  it('starts a real manual run on the resulting enabled scope with project provenance', async () => {
    const result = await post({
      name: name(),
      hostIds: [localAsset],
      jobs,
      runNow: true,
    }).expect(201);
    expect(result.body.creation.initialRun).toEqual({
      status: 'started',
      jobHistoryId: expect.any(String),
    });
    const [run] = await query(
      'SELECT "projectId","projectWorkflowId",scope,"jobRunType" FROM job_histories WHERE id=$1',
      [result.body.creation.initialRun.jobHistoryId],
    );
    expect(run).toMatchObject({
      projectId: result.body.id,
      projectWorkflowId: expect.any(String),
      scope: { assetIds: [localAsset] },
      jobRunType: 'manual',
    });
  });
  it('keeps an empty project when runNow has no eligible assets', async () => {
    const result = await post({
      name: name(),
      scopeRules: [],
      template,
      runNow: true,
    }).expect(201);
    expect(result.body.creation.initialRun).toEqual({ status: 'empty_scope' });
    expect(
      await query('SELECT id FROM job_histories WHERE "projectId"=$1', [
        result.body.id,
      ]),
    ).toEqual([]);
  });
  it('rejects launch and trigger activation without workflow write before setup', async () => {
    const before = await counts();
    for (const extra of [
      { runNow: true },
      { on: { schedule: [{ cron: '0 8 * * *', enabled: true }] } },
      { scopeRules: [], schedule: '0 8 * * *' },
    ])
      await post({ name: name(), jobs, ...extra }, reader()).expect(403);
    expect(await counts()).toEqual(before);
    await post(
      {
        name: name(),
        jobs,
        on: { schedule: [{ cron: '0 8 * * *', enabled: false }] },
      },
      reader(),
    ).expect(201);
  });
  it.each([
    { scopeRules: [{ mode: 'include', type: 'asset', value: 'foreign' }] },
    { template: 'missing.yaml' },
    { jobs: { probe: { run: 'missing-creation-tool' } } },
    { jobs: { probe: { run: 'subfinder', needs: ['missing'] } } },
    { jobs, template },
    { runNow: true },
    { on: { schedule: [] } },
    { workflowName: 'No pipeline' },
    { jobs, on: { schedule: [{ cron: 'invalid' }] } },
    { jobs, on: { events: [{ event: 'unknown' }] } },
    { scopeRules: null },
    { jobs: null },
    { runNow: null },
    { template: ' ' },
    { workflowName: ' ' },
  ])('leaves no partial setup for invalid creation %j', async (extra) => {
    const before = await counts();
    const response = await post({ name: name(), ...extra });
    expect([400, 404]).toContain(response.status);
    expect(await counts()).toEqual(before);
  });
  it('rejects foreign owned references without creating any rows', async () => {
    const before = await counts();
    for (const extra of [
      { hostIds: [foreignAsset], scopeRules: [] },
      { scopeRules: [{ mode: 'include', type: 'asset', value: foreignAsset }] },
    ])
      await post({ name: name(), ...extra }).expect(400);
    expect(await counts()).toEqual(before);
  });
  it('rolls back the setup transaction after a workflow write fails', async () => {
    const before = await counts(),
      original = EntityManager.prototype.save;
    const save = jest
      .spyOn(EntityManager.prototype, 'save')
      .mockImplementation(async function (...args) {
        const saved: unknown = await original.apply(this, args);
        if (args[0] === Workflow) throw new Error('Simulated setup failure');
        return saved;
      });
    try {
      await post({
        name: name(),
        hostIds: [localAsset],
        scopeRules: [{ mode: 'include', type: 'target', value: target }],
        jobs,
      }).expect(500);
    } finally {
      save.mockRestore();
    }
    expect(await counts()).toEqual(before);
  });
  it('returns saved project and generic recovery outcomes after postcommit failures', async () => {
    const launch = jest
      .spyOn(app.app.get(ProjectWorkflowActionsService), 'run')
      .mockRejectedValueOnce(new Error('PRIVATE_TOKEN_IN_ERROR'));
    const sync = jest
      .spyOn(app.app.get(ProjectTriggerRuntimeService), 'reconcile')
      .mockRejectedValueOnce(new Error('PRIVATE_REDIS_SECRET'));
    try {
      const result = await post({
        name: name(),
        hostIds: [localAsset],
        jobs,
        runNow: true,
        on: { schedule: [{ cron: '0 8 * * *', enabled: true }] },
      }).expect(201);
      expect(result.body.creation).toEqual({
        initialRun: { status: 'failed' },
        triggerSync: 'pending',
      });
      expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_/);
      await request(app.server)
        .get(`/api/projects/${result.body.id}`)
        .set(owner.headers)
        .expect(200);
    } finally {
      launch.mockRestore();
      sync.mockRestore();
    }
  });
  it('retains a saved project when the postcommit scope lookup fails once', async () => {
    const original = app.dataSource.query.bind(app.dataSource);
    let failed = false;
    const lookup = jest
      .spyOn(app.dataSource, 'query')
      .mockImplementation((sql, ...args) => {
        if (
          !failed &&
          String(sql).includes(
            'SELECT count(*)::int AS count FROM project_assets pa',
          )
        ) {
          failed = true;
          return Promise.reject(new Error('One-shot scope lookup failure'));
        }
        return original(sql, ...args) as Promise<unknown>;
      });
    try {
      const result = await post({
        name: name(),
        hostIds: [localAsset],
        jobs,
        runNow: true,
      }).expect(201);
      expect(failed).toBe(true);
      expect(result.body.creation.initialRun).toEqual({ status: 'failed' });
      await request(app.server)
        .get(`/api/projects/${result.body.id}`)
        .set(owner.headers)
        .expect(200);
    } finally {
      lookup.mockRestore();
    }
  });
  it('encrypts connector secrets for templates, selected jobs and staged tool creation', async () => {
    const toolName = 'creation-' + randomUUID(),
      secret = 'local-creation-secret',
      file = 'secret-' + randomUUID() + '.yaml';
    const tool = await insert(
      'INSERT INTO tools(name,type,categories) VALUES($1,$2,$3)',
      [
        toolName,
        'connector',
        JSON.stringify([
          {
            name: 'vulnerabilities',
            targetTypes: ['DOMAIN'],
            inputs: ['host'],
          },
        ]),
      ],
    );
    const graph = { scan: { run: toolName, config: { apiKey: secret } } };
    await query(
      'INSERT INTO workflows(name,"filePath",content,"workspaceId","isCanEdit") VALUES($1,$2,$3,$4,false)',
      [
        name(),
        file,
        { name: 'Secret default', jobs: graph },
        owner.workspace.id,
      ],
    );
    const registry = jest
      .spyOn(app.app.get(ConnectorRegistryService), 'getConnector')
      .mockReturnValue({
        configSchema: {
          required: ['apiKey'],
          properties: { apiKey: { type: 'string', 'ui:widget': 'password' } },
        },
      } as ReturnType<ConnectorRegistryService['getConnector']>);
    try {
      const dek = await app.app
        .get(WorkspaceEncryptionService)
        .getDEK(owner.workspace.id);
      let ciphertext = '';
      for (const source of [
        { template: file },
        { jobs: graph },
        {
          scopeRules: [],
          tools: [{ toolId: tool, stage: 2, config: { apiKey: secret } }],
        },
      ]) {
        const result = await post({ name: name(), ...source }).expect(201);
        const [saved] = await query(
          'SELECT w.content FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw."projectId"=$1',
          [result.body.id],
        );
        const job = Object.values(saved.content.jobs)[0] as {
          config: { apiKey: string };
        };
        expect(job.config.apiKey).not.toBe(secret);
        expect(decryptInlineConfig(job.config, ['apiKey'], dek).apiKey).toBe(
          secret,
        );
        expect(JSON.stringify(result.body)).not.toContain(secret);
        ciphertext = job.config.apiKey;
      }
      await query(
        'UPDATE workflows SET content=$1 WHERE "filePath"=$2 AND "workspaceId"=$3',
        [
          {
            name: 'Encrypted default',
            jobs: { scan: { run: toolName, config: { apiKey: ciphertext } } },
          },
          file,
          owner.workspace.id,
        ],
      );
      const copied = await post({ name: name(), template: file }).expect(201);
      const [stored] = await query(
        'SELECT w.content FROM workflows w JOIN project_workflows pw ON pw."workflowId"=w.id WHERE pw."projectId"=$1',
        [copied.body.id],
      );
      expect(stored.content.jobs.scan.config.apiKey).toBe(ciphertext);
    } finally {
      registry.mockRestore();
      await query('DELETE FROM tools WHERE id=$1', [tool]);
    }
  });

  it('serializes duplicate project names and retains tenant/authentication boundaries', async () => {
    const shared = name();
    const results = await Promise.all([
      post({ name: shared, scopeRules: [] }),
      post({ name: shared, scopeRules: [] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    await request(app.server)
      .post('/api/projects')
      .send({ name: name(), scopeRules: [] })
      .expect(401);
    await post(
      { name: name(), scopeRules: [] },
      { ...owner.headers, 'X-Workspace-Id': other.workspace.id },
    ).expect(403);
  });
});
