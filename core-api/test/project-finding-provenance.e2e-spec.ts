import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { Severity, ToolCategory } from '../src/common/enums/enum';
import { ProjectFindingReadService } from '../src/modules/projects/project-finding-read.service';
import { VulnerabilityStatus } from '../src/modules/vulnerabilities/dto/get-vulnerability.dto';
import {
  PROJECT_FINDING_PROVENANCE_SQL,
  PROJECT_FINDING_REFERENCE_JOINS,
} from '../src/modules/projects/project-finding-provenance';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Project finding provenance (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let project: string,
    sibling: string,
    workflow: string,
    foreignWorkflow: string;
  let asset: string, unrelatedAsset: string, tool: string, otherTool: string;
  let link: string, firstRun: string, foreignRun: string;
  const tieIdStem = randomUUID().slice(0, -1);
  const at = (day: number) =>
    `2026-02-${String(day).padStart(2, '0')} 00:00:00`;
  const insert = async (table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row).map((k) => `"${k}"`),
      params = names.map((_, i) => `$${i + 1}`);
    const [{ id }] = await app.dataSource.query<{ id: string }[]>(
      `INSERT INTO ${table} (${names.join(',')}) VALUES (${params.join(',')}) RETURNING id`,
      Object.values(row),
    );
    return id;
  };
  const run = async (
    day: number,
    settings: {
      projectId?: string | null;
      workflowId?: string;
      assetId?: string;
      toolId?: string;
      status?: string;
      category?: ToolCategory;
      historyId?: string;
    } = {},
  ) => {
    const {
      projectId = project,
      workflowId = workflow,
      assetId = asset,
      toolId = tool,
      status = 'completed',
      category = ToolCategory.VULNERABILITIES,
      historyId = randomUUID(),
    } = settings;
    const id = await insert('job_histories', {
      id: historyId,
      projectId,
      workflowId,
      createdAt: at(day),
    });
    await insert('jobs', {
      jobHistoryId: id,
      assetId,
      toolId,
      status,
      category,
    });
    return id;
  };
  const read = async (db: Pick<EntityManager, 'query'> = app.dataSource) =>
    (
      await db.query<{ referenceRunId: string | null; provenance: string }[]>(
        `SELECT ref.id AS "referenceRunId", ${PROJECT_FINDING_PROVENANCE_SQL} AS provenance
       FROM project_vulnerabilities pv JOIN vulnerabilities v ON v.id=pv."vulnerabilityId"
       ${PROJECT_FINDING_REFERENCE_JOINS} WHERE pv.id=$1`,
        [link],
      )
    )[0];
  const deleteRun = (id: string) =>
    app.dataSource.query('DELETE FROM job_histories WHERE id=$1', [id]);
  const restore = () =>
    app.dataSource.query(
      'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=$1,"lastSeenAt"=$2,"timesSeen"=1 WHERE id=$3',
      [firstRun, at(1), link],
    );

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(
      app.server,
      'finding-reference-owner',
    );
    other = await createUserWithWorkspace(
      app.server,
      'finding-reference-other',
    );
    const workspaceId = owner.workspace.id;
    project = await insert('projects', { name: randomUUID(), workspaceId });
    sibling = await insert('projects', { name: randomUUID(), workspaceId });
    const makeWorkflow = (workspaceId: string) =>
      insert('workflows', {
        name: randomUUID(),
        filePath: randomUUID() + '.yaml',
        content: { name: 'Argus finding reference', jobs: {} },
        workspaceId,
      });
    workflow = await makeWorkflow(workspaceId);
    foreignWorkflow = await makeWorkflow(other.workspace.id);
    const value = randomUUID() + '.argus.test',
      targetId = await insert('targets', {
        value,
        type: 'DOMAIN',
        workspaceId,
      });
    asset = await insert('assets', { value, targetId });
    unrelatedAsset = await insert('assets', {
      value: 'unrelated.' + value,
      targetId,
    });
    const tools = await app.dataSource.query<{ id: string; name: string }[]>(
      'SELECT id,name FROM tools WHERE name=ANY($1::text[])',
      [['nmap', 'nuclei']],
    );
    tool = tools.find((row) => row.name === 'nmap')!.id;
    otherTool = tools.find((row) => row.name === 'nuclei')!.id;
    firstRun = await run(1, { historyId: tieIdStem + '0' });
    const vulnerabilityId = await insert('vulnerabilities', {
      name: randomUUID(),
      severity: 'high',
      assetId: asset,
      toolId: tool,
    });
    link = await insert('project_vulnerabilities', {
      projectId: project,
      vulnerabilityId,
      firstSeenJobHistoryId: firstRun,
      lastSeenJobHistoryId: firstRun,
      firstSeenAt: at(1),
      lastSeenAt: at(1),
      timesSeen: 1,
    });
    await run(8, { assetId: unrelatedAsset });
    await run(9, { toolId: otherTool });
    await run(10, { status: 'failed' });
    await run(11, { projectId: sibling });
    await run(12, { projectId: null });
    foreignRun = await run(13, { workflowId: foreignWorkflow });
  });
  afterAll(async () => {
    if (!app) return;
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });

  it('ignores unrelated assets and tools, failures, sibling projects, standalone and foreign workflows', async () => {
    expect(await read()).toEqual({
      referenceRunId: firstRun,
      provenance: 'new',
    });
  });
  it('ignores a later Nmap port scan of the same asset', async () => {
    const portScan = await run(14, { category: ToolCategory.PORTS_SCANNER });
    try {
      expect(await read()).toEqual({
        referenceRunId: firstRun,
        provenance: 'new',
      });
    } finally {
      await deleteRun(portScan);
    }
  });
  it('distinguishes a later eligible miss from an exact observed run without moving its legacy pointer', async () => {
    const candidate = await run(2);
    try {
      const snapshot = () =>
        app.dataSource.query(
          'SELECT * FROM project_vulnerabilities WHERE id=$1',
          [link],
        );
      const before = await snapshot();
      expect(await read()).toEqual({
        referenceRunId: candidate,
        provenance: 'not_seen',
      });
      expect(await snapshot()).toEqual(before);
      const observation = await insert('project_vulnerability_observations', {
        projectVulnerabilityId: link,
        jobHistoryId: candidate,
        seenAt: at(2),
      });
      try {
        await app.dataSource.query(
          'UPDATE project_vulnerabilities SET "timesSeen"=2 WHERE id=$1',
          [link],
        );
        expect(await read()).toEqual({
          referenceRunId: candidate,
          provenance: 'recurring',
        });
      } finally {
        await app.dataSource.query(
          'DELETE FROM project_vulnerability_observations WHERE id=$1',
          [observation],
        );
      }
    } finally {
      await restore();
      await deleteRun(candidate);
    }
  });
  it('uses the retained UTC sighting time for invalid or lost run pointers', async () => {
    const candidate = await run(3);
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SET LOCAL TIME ZONE 'America/Chicago'");
      await runner.query(
        'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=$1,"lastSeenAt"=$2,"timesSeen"=2 WHERE id=$3',
        [foreignRun, '2026-02-02T22:00:00Z', link],
      );
      expect(await read(runner.manager)).toEqual({
        referenceRunId: candidate,
        provenance: 'not_seen',
      });
      await runner.query(
        'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=NULL,"lastSeenAt"=$1 WHERE id=$2',
        ['2026-02-03T02:00:00Z', link],
      );
      const expected = { referenceRunId: candidate, provenance: 'recurring' };
      expect(await read(runner.manager)).toEqual(expected);
      await runner.query("SET LOCAL TIME ZONE 'UTC'");
      expect(await read(runner.manager)).toEqual(expected);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
      await deleteRun(candidate);
    }
  });
  it('breaks reference ties by run ID without treating equal start times as a miss', async () => {
    const candidate = await run(1, { historyId: tieIdStem + 'f' });
    try {
      expect(await read()).toEqual({
        referenceRunId: candidate,
        provenance: 'new',
      });
    } finally {
      await deleteRun(candidate);
    }
  });
  describe('private finding list', () => {
    let service: ProjectFindingReadService,
      openId: string,
      archivedId: string,
      dismissedId: string;
    const list = (
      query: Partial<Parameters<ProjectFindingReadService['list']>[2]> = {},
    ) =>
      service.list(project.toUpperCase(), owner.workspace.id, {
        page: 1,
        limit: 10,
        ...query,
      });
    beforeAll(async () => {
      service = app.app.get(ProjectFindingReadService);
      openId = (
        await app.dataSource.query<{ id: string }[]>(
          'SELECT "vulnerabilityId" AS id FROM project_vulnerabilities WHERE id=$1',
          [link],
        )
      )[0].id;
      archivedId = await insert('vulnerabilities', {
        name: 'Archived 100%_ literal',
        assetId: asset,
        severity: Severity.LOW,
        isArchived: true,
      });
      dismissedId = await insert('vulnerabilities', {
        name: 'Dismissed 100xy literal',
        assetId: asset,
        severity: Severity.CRITICAL,
        cveId: ['CVE-2026-99991'],
      });
      await insert('vulnerability_dismissals', {
        vulnerabilityId: dismissedId,
        userId: owner.user.userId,
        reason: 'used_in_test',
      });
      await insert('project_vulnerabilities', {
        projectId: project,
        vulnerabilityId: archivedId,
        firstSeenJobHistoryId: foreignRun,
        lastSeenJobHistoryId: foreignRun,
      });
      await insert('project_vulnerabilities', {
        projectId: project,
        vulnerabilityId: dismissedId,
      });
      const unrelated = await insert('vulnerabilities', {
        name: 'Unrelated',
        assetId: asset,
        severity: Severity.CRITICAL,
      });
      await insert('project_vulnerabilities', {
        projectId: sibling,
        vulnerabilityId: unrelated,
      });
      const value = randomUUID() + '.argus.test',
        targetId = await insert('targets', {
          value,
          type: 'DOMAIN',
          workspaceId: other.workspace.id,
        });
      const foreignAsset = await insert('assets', { value, targetId });
      const foreign = await insert('vulnerabilities', {
        name: 'Forged cross-tenant link',
        assetId: foreignAsset,
        severity: Severity.CRITICAL,
      });
      await insert('project_vulnerabilities', {
        projectId: project,
        vulnerabilityId: foreign,
      });
    });
    it('returns linked open findings without requiring current membership and exposes only safe summary fields', async () => {
      const result = await list();
      expect(result).toMatchObject({
        total: 1,
        hasNextPage: false,
        data: [
          {
            id: openId,
            assetId: asset,
            provenance: 'new',
            status: 'open',
            timesSeen: 1,
            firstSeen: { runId: firstRun },
            lastSeen: { runId: firstRun },
          },
        ],
      });
      expect(Object.keys(result.data[0]).sort()).toEqual(
        [
          'id',
          'name',
          'severity',
          'cveId',
          'affectedUrl',
          'assetId',
          'assetValue',
          'toolName',
          'status',
          'provenance',
          'timesSeen',
          'firstSeen',
          'lastSeen',
        ].sort(),
      );
    });
    it('applies existing dismissal semantics, bound filters and stable page metadata', async () => {
      const status = VulnerabilityStatus.ALL;
      expect((await list({ status })).data.map((row) => row.id)).toEqual([
        dismissedId,
        openId,
        archivedId,
      ]);
      const dismissed = await list({ status: VulnerabilityStatus.DISMISSED });
      expect(dismissed.data).toEqual([
        expect.objectContaining({ id: dismissedId, status: 'dismissed' }),
      ]);
      const literal = await list({ status, search: '100%_' });
      expect(literal.data).toEqual([
        expect.objectContaining({
          id: archivedId,
          firstSeen: expect.objectContaining({ runId: null }),
          lastSeen: expect.objectContaining({ runId: null }),
        }),
      ]);
      expect(
        (await list({ status, search: 'cve-2026-99991' })).data.map(
          (row) => row.id,
        ),
      ).toEqual([dismissedId]);
      expect(
        (
          await list({ status, severity: [Severity.LOW], assetId: asset })
        ).data.map((row) => row.id),
      ).toEqual([archivedId]);
      expect(await list({ status, limit: 1, page: 4 })).toMatchObject({
        total: 3,
        pageCount: 3,
        data: [],
        hasNextPage: false,
      });
      expect(await list({ assetId: randomUUID() })).toMatchObject({
        total: 0,
        data: [],
      });
    });
    it('rejects foreign projects and malformed paging without writing findings', async () => {
      const snapshot = () =>
        app.dataSource.query(
          'SELECT * FROM project_vulnerabilities WHERE "projectId"=$1 ORDER BY id',
          [project],
        );
      const before = await snapshot();
      await expect(
        service.list(project, other.workspace.id, { page: 1, limit: 10 }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(list({ limit: 101 })).rejects.toMatchObject({ status: 400 });
      await list({ status: VulnerabilityStatus.ALL });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('private finding run filters', () => {
    let openId: string;
    let firstBinding: string;
    let laterBinding: string;
    let otherBinding: string;
    let middle: string;
    let last: string;
    let siblingRun: string;
    let corruptRun: string;
    const list = async (
      query: Partial<Parameters<ProjectFindingReadService['list']>[2]>,
    ) => {
      const service = app.app.get(ProjectFindingReadService);
      return service.list(project, owner.workspace.id, {
        page: 1,
        limit: 10,
        ...query,
      });
    };
    const setBinding = (historyId: string, bindingId: string) =>
      app.dataSource.query(
        'UPDATE job_histories SET "projectWorkflowId"=$1 WHERE id=$2',
        [bindingId, historyId],
      );

    beforeAll(async () => {
      openId = (
        await app.dataSource.query<{ id: string }[]>(
          'SELECT "vulnerabilityId" AS id FROM project_vulnerabilities WHERE id=$1',
          [link],
        )
      )[0].id;
      const laterWorkflow = await insert('workflows', {
        name: randomUUID(),
        filePath: randomUUID() + '.yaml',
        content: { name: 'Argus intermediate finding', jobs: {} },
        workspaceId: owner.workspace.id,
      });
      firstBinding = await insert('project_workflows', {
        projectId: project,
        workflowId: workflow,
      });
      laterBinding = await insert('project_workflows', {
        projectId: project,
        workflowId: laterWorkflow,
      });
      otherBinding = await insert('project_workflows', {
        projectId: sibling,
        workflowId: workflow,
      });
      middle = await run(4, { workflowId: laterWorkflow });
      last = await run(6);
      siblingRun = await run(7, { projectId: sibling });
      corruptRun = await run(8);
      await setBinding(firstRun, firstBinding);
      await setBinding(middle, laterBinding);
      await setBinding(last, firstBinding);
      await setBinding(siblingRun, otherBinding);
      await setBinding(foreignRun, laterBinding);
      await setBinding(corruptRun, laterBinding);
      for (const jobHistoryId of [middle, siblingRun, foreignRun, corruptRun])
        await insert('project_vulnerability_observations', {
          projectVulnerabilityId: link,
          jobHistoryId,
        });
      await app.dataSource.query(
        'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=$1,"lastSeenAt"=$2,"timesSeen"=3 WHERE id=$3',
        [last, at(6), link],
      );
    });

    it('finds an exact intermediate sighting and both legacy pointers', async () => {
      for (const jobHistoryId of [firstRun, middle, last]) {
        const result = await list({ jobHistoryId, limit: 1 });
        expect(result).toMatchObject({ total: 1, data: [{ id: openId }] });
      }
      expect(
        await list({ jobHistoryId: middle, page: 2, limit: 1 }),
      ).toMatchObject({
        total: 1,
        data: [],
      });
      expect(await list({ jobHistoryId: randomUUID() })).toMatchObject({
        total: 0,
        data: [],
      });
    });

    it('intersects workflow and run filters on the same owned sighting', async () => {
      expect(await list({ projectWorkflowId: laterBinding })).toMatchObject({
        total: 1,
        data: [{ id: openId }],
      });
      expect(await list({ projectWorkflowId: firstBinding })).toMatchObject({
        total: 1,
      });
      expect(
        await list({
          projectWorkflowId: laterBinding,
          jobHistoryId: middle.toUpperCase(),
        }),
      ).toMatchObject({ total: 1 });
      expect(
        await list({ projectWorkflowId: laterBinding, jobHistoryId: firstRun }),
      ).toMatchObject({ total: 0 });
    });

    it('ignores forged project, workspace, and workflow binding associations', async () => {
      for (const jobHistoryId of [siblingRun, foreignRun])
        expect(await list({ jobHistoryId })).toMatchObject({
          total: 0,
          data: [],
        });
      expect(await list({ projectWorkflowId: otherBinding })).toMatchObject({
        total: 0,
      });
      expect(
        await list({
          projectWorkflowId: laterBinding,
          jobHistoryId: corruptRun,
        }),
      ).toMatchObject({ total: 0 });
      expect(await list({ jobHistoryId: corruptRun })).toMatchObject({
        total: 1,
      });
    });
  });
});
