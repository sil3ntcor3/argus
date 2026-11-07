import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import type { EntityManager } from 'typeorm';
import { Severity, ToolCategory } from '../src/common/enums/enum';
import { ProjectFindingReadService } from '../src/modules/projects/project-finding-read.service';
import { ProjectFindingTimelineService } from '../src/modules/projects/project-finding-timeline.service';
import { VulnerabilityStatus } from '../src/modules/vulnerabilities/dto/get-vulnerability.dto';
import {
  PROJECT_FINDING_PROVENANCE_SQL,
  PROJECT_FINDING_REFERENCE_JOINS,
  ProjectFindingProvenance,
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
      isSaveData?: boolean;
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
      isSaveData = true,
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
      isSaveData,
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
  it('ignores completed scans that did not save results as evidence of a miss', async () => {
    const unsaved = await run(14, { isSaveData: false });
    try {
      expect(await read()).toEqual({
        referenceRunId: firstRun,
        provenance: 'new',
      });
    } finally {
      await deleteRun(unsaved);
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

  describe('private finding facets', () => {
    let facetProject: string;
    let newest: string;
    const list = (
      query: Partial<Parameters<ProjectFindingReadService['list']>[2]> = {},
    ) =>
      app.app
        .get(ProjectFindingReadService)
        .list(facetProject, owner.workspace.id, {
          page: 1,
          limit: 10,
          ...query,
        });
    const severities = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    const provenance = { all: 0, new: 0, recurring: 0, notSeen: 0 };

    beforeAll(async () => {
      facetProject = await insert('projects', {
        name: randomUUID(),
        workspaceId: owner.workspace.id,
      });
      const oldest = await run(1, { projectId: facetProject });
      newest = await run(2, { projectId: facetProject });
      const rows = [
        ['High new', Severity.HIGH, newest, 1],
        ['Medium new', Severity.MEDIUM, newest, 1],
        ['High recurring', Severity.HIGH, newest, 2],
        ['Low missed', Severity.LOW, oldest, 2],
        ['Critical missed', Severity.CRITICAL, oldest, 2],
        ['High archived', Severity.HIGH, oldest, 2],
        ['Medium dismissed', Severity.MEDIUM, newest, 1],
      ] as const;
      for (const [name, severity, lastRun, timesSeen] of rows) {
        const vulnerabilityId = await insert('vulnerabilities', {
          name,
          severity,
          assetId: asset,
          toolId: tool,
          isArchived: name.endsWith('archived'),
        });
        if (name.endsWith('dismissed'))
          await insert('vulnerability_dismissals', {
            vulnerabilityId,
            userId: owner.user.userId,
            reason: 'used_in_test',
          });
        await insert('project_vulnerabilities', {
          projectId: facetProject,
          vulnerabilityId,
          firstSeenJobHistoryId: timesSeen > 1 ? oldest : lastRun,
          lastSeenJobHistoryId: lastRun,
          firstSeenAt: at(timesSeen > 1 || lastRun === oldest ? 1 : 2),
          lastSeenAt: at(lastRun === oldest ? 1 : 2),
          timesSeen,
        });
      }
    });

    it('keeps independent facet dimensions while the page applies both filters', async () => {
      const result = await list({
        severity: [Severity.HIGH],
        provenance: ProjectFindingProvenance.NEW,
      });
      expect(result).toMatchObject({
        total: 1,
        data: [{ name: 'High new', provenance: 'new' }],
        provenanceCounts: { ...provenance, all: 2, new: 1, recurring: 1 },
        severityCounts: { ...severities, high: 1, medium: 1 },
      });
      expect(
        await list({
          severity: [Severity.LOW],
          provenance: ProjectFindingProvenance.NEW,
        }),
      ).toMatchObject({
        total: 0,
        data: [],
        provenanceCounts: { ...provenance, all: 1, notSeen: 1 },
        severityCounts: { ...severities, high: 1, medium: 1 },
      });
      expect(
        await list({ provenance: ProjectFindingProvenance.NOT_SEEN }),
      ).toMatchObject({
        total: 2,
        data: [{ name: 'Critical missed' }, { name: 'Low missed' }],
        provenanceCounts: { all: 5, new: 2, recurring: 1, notSeen: 2 },
        severityCounts: { ...severities, low: 1, critical: 1 },
      });
    });

    it('preserves facets on an out-of-range page and returns zero for no matches', async () => {
      expect(await list({ page: 99, limit: 1 })).toMatchObject({
        total: 5,
        data: [],
        provenanceCounts: { all: 5, new: 2, recurring: 1, notSeen: 2 },
        severityCounts: {
          ...severities,
          high: 2,
          medium: 1,
          low: 1,
          critical: 1,
        },
      });
      expect(await list({ search: 'does not exist' })).toMatchObject({
        total: 0,
        data: [],
        provenanceCounts: provenance,
        severityCounts: severities,
      });
    });

    it('applies status, literal search and exact run filters to every facet', async () => {
      expect(
        await list({ status: VulnerabilityStatus.DISMISSED }),
      ).toMatchObject({
        total: 1,
        data: [{ name: 'Medium dismissed' }],
        provenanceCounts: { ...provenance, all: 1, new: 1 },
        severityCounts: { ...severities, medium: 1 },
      });
      expect(
        await list({
          status: VulnerabilityStatus.ALL,
          search: 'HIGH',
          jobHistoryId: newest,
        }),
      ).toMatchObject({
        total: 2,
        provenanceCounts: { ...provenance, all: 2, new: 1, recurring: 1 },
        severityCounts: { ...severities, high: 2 },
      });
    });

    describe('project findings HTTP API', () => {
      const path = (id = facetProject) => `/api/projects/${id}/vulnerabilities`;

      it('serves the page and independently scoped facets with default and repeated filters', async () => {
        const defaults = await request(app.server)
          .get(path())
          .set(owner.headers)
          .expect(200);
        expect(defaults.body).toMatchObject({
          total: 5,
          page: 1,
          limit: 10,
          pageCount: 1,
          hasNextPage: false,
          provenanceCounts: { all: 5, new: 2, recurring: 1, notSeen: 2 },
          severityCounts: { critical: 1, high: 2, medium: 1, low: 1, info: 0 },
        });
        const filtered = await request(app.server)
          .get(path() + '?severity=high&severity=low&provenance=new')
          .set(owner.headers)
          .expect(200);
        expect(filtered.body).toMatchObject({
          total: 1,
          data: [
            {
              name: 'High new',
              status: 'open',
              provenance: 'new',
              lastSeen: { runId: newest },
            },
          ],
          provenanceCounts: { all: 3, new: 1, recurring: 1, notSeen: 1 },
          severityCounts: { ...severities, high: 1, medium: 1 },
        });
        const run = await request(app.server)
          .get(path())
          .query({ jobHistoryId: newest, search: 'high', page: 2, limit: 1 })
          .set(owner.headers)
          .expect(200);
        expect(run.body).toMatchObject({
          total: 2,
          page: 2,
          limit: 1,
          hasNextPage: false,
        });
      });

      it('rejects malformed filters and pagination before querying', async () => {
        for (const query of [
          { assetId: 'invalid' },
          { jobHistoryId: 'invalid' },
          { projectWorkflowId: 'invalid' },
          { status: 'closed' },
          { severity: 'urgent' },
          { provenance: 'old' },
          { limit: 101 },
          { page: 1.5 },
          { search: 'x'.repeat(201) },
        ])
          await request(app.server)
            .get(path())
            .query(query)
            .set(owner.headers)
            .expect(400);
        await request(app.server)
          .get(path('invalid'))
          .set(owner.headers)
          .expect(400);
        await request(app.server)
          .get(path() + '?search=a%00b')
          .set(owner.headers)
          .expect(400);
      });

      it('enforces authentication and workspace boundaries', async () => {
        await request(app.server)
          .get(path())
          .set('X-Workspace-Id', owner.workspace.id)
          .expect(401);
        await request(app.server)
          .get(path())
          .set({ ...other.headers, 'X-Workspace-Id': owner.workspace.id })
          .expect(403);
        await request(app.server).get(path()).set(other.headers).expect(404);
        await request(app.server)
          .get(path(randomUUID()))
          .set(owner.headers)
          .expect(404);
      });

      it('requires project read permission from a workspace member', async () => {
        const workspaceId = owner.workspace.id;
        const headers = { ...other.headers, 'X-Workspace-Id': workspaceId };
        const memberId = await insert('workspace_members', {
          workspaceId,
          userId: other.user.userId,
        });
        const permissionId = await insert('workspace_permissions', {
          workspaceId,
          name: randomUUID(),
          permissions: ['group.read'],
        });
        await request(app.server).get(path()).set(headers).expect(403);
        await insert('workspace_member_permissions', {
          memberId,
          permissionId,
        });
        await request(app.server).get(path()).set(headers).expect(200);
      });
    });
  });

  describe('private finding timeline', () => {
    let timelineProject: string;
    let findingId: string;
    let timelineLink: string;
    let first: string;
    let unknown: string;
    let observed: string;
    let last: string;
    let sameTime: string;
    let missed: string;
    const timeline = () => app.app.get(ProjectFindingTimelineService);
    const read = () =>
      timeline().read(timelineProject, owner.workspace.id, findingId);

    beforeAll(async () => {
      timelineProject = await insert('projects', {
        name: randomUUID(),
        workspaceId: owner.workspace.id,
      });
      const start = (day: number, settings: Parameters<typeof run>[1] = {}) =>
        run(day, { projectId: timelineProject, ...settings });
      const tied = randomUUID().slice(0, -1);
      await start(1); // before the first sighting
      first = await start(2);
      unknown = await start(3);
      observed = await start(4, { status: 'failed' });
      last = await start(5, { historyId: tied + '0' });
      sameTime = await start(5, { historyId: tied + 'f' });
      missed = await start(6);
      await insert('jobs', {
        jobHistoryId: missed,
        assetId: asset,
        toolId: tool,
        status: 'completed',
        category: ToolCategory.VULNERABILITIES,
      });
      await start(7, { category: ToolCategory.PORTS_SCANNER });
      await start(7, { assetId: unrelatedAsset });
      await start(7, { toolId: otherTool });
      const wrongWorkflow = await start(8, { workflowId: foreignWorkflow });
      const wrongProject = await start(9, { projectId: sibling });
      findingId = await insert('vulnerabilities', {
        name: 'Finding timeline fixture',
        severity: Severity.HIGH,
        assetId: asset,
        toolId: tool,
      });
      timelineLink = await insert('project_vulnerabilities', {
        projectId: timelineProject,
        vulnerabilityId: findingId,
        firstSeenJobHistoryId: first,
        lastSeenJobHistoryId: last,
        firstSeenAt: at(2),
        lastSeenAt: at(5),
        timesSeen: 3,
      });
      for (const jobHistoryId of [observed, wrongWorkflow, wrongProject]) {
        await insert('project_vulnerability_observations', {
          projectVulnerabilityId: timelineLink,
          jobHistoryId,
        });
      }
    });

    it('uses exact and legacy sightings, preserves uncertainty, and excludes ineligible runs', async () => {
      const result = await read();
      expect(result.vulnerability).toMatchObject({
        id: findingId,
        firstSeen: { runId: first },
        lastSeen: { runId: last },
        provenance: 'not_seen',
      });
      expect(result.runs.map((row) => [row.id, row.sighting])).toEqual([
        [first, 'seen'],
        [unknown, 'unknown'],
        [observed, 'seen'],
        [last, 'seen'],
        [sameTime, 'unknown'],
        [missed, 'missed'],
      ]);
      expect(Object.keys(result.runs[0]).sort()).toEqual([
        'createdAt',
        'id',
        'sighting',
        'workflowName',
      ]);
    });

    it('orders the evidence window by run start even when reports arrive out of order', async () => {
      const pointers = (a: string, b: string) =>
        app.dataSource.query(
          'UPDATE project_vulnerabilities SET "firstSeenJobHistoryId"=$1,"lastSeenJobHistoryId"=$2 WHERE id=$3',
          [a, b, timelineLink],
        );
      const saveResults = (enabled: boolean) =>
        app.dataSource.query(
          'UPDATE jobs SET "isSaveData"=$1 WHERE "jobHistoryId"=ANY($2::uuid[])',
          [enabled, [last, missed]],
        );
      await pointers(last, first);
      await saveResults(false);
      try {
        const result = await read();
        expect(result.vulnerability.provenance).toBe('recurring');
        expect(result.runs.map((row) => [row.id, row.sighting])).toEqual([
          [first, 'seen'],
          [unknown, 'unknown'],
          [observed, 'seen'],
          [last, 'seen'],
          [sameTime, 'unknown'],
        ]);
      } finally {
        await saveResults(true);
        await pointers(first, last);
      }
    });

    it('finds archived linked records and uses retained timestamps after a last-run reference disappears', async () => {
      await app.dataSource.query(
        'UPDATE vulnerabilities SET "isArchived"=true WHERE id=$1',
        [findingId],
      );
      await app.dataSource.query(
        'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=NULL WHERE id=$1',
        [timelineLink],
      );
      try {
        const result = await read();
        expect(result.vulnerability).toMatchObject({
          id: findingId,
          lastSeen: { runId: null },
        });
        expect(result.runs.find((row) => row.id === sameTime)?.sighting).toBe(
          'unknown',
        );
        expect(result.runs.find((row) => row.id === missed)?.sighting).toBe(
          'missed',
        );
      } finally {
        await app.dataSource.query(
          'UPDATE vulnerabilities SET "isArchived"=false WHERE id=$1',
          [findingId],
        );
        await app.dataSource.query(
          'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=$1 WHERE id=$2',
          [last, timelineLink],
        );
      }
    });

    it('rejects cross-workspace, unlinked and nonexistent findings', async () => {
      await expect(
        timeline().read(timelineProject, owner.workspace.id, ''),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        timeline().read(timelineProject, other.workspace.id, findingId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        timeline().read(sibling, owner.workspace.id, findingId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        timeline().read(timelineProject, owner.workspace.id, randomUUID()),
      ).rejects.toMatchObject({ status: 404 });
    });

    describe('project finding timeline HTTP API', () => {
      const path = (projectId = timelineProject, id = findingId) =>
        `/api/projects/${projectId}/vulnerabilities/${id}/timeline`;

      it('returns only safe run summaries and distinguishes the three sighting states', async () => {
        const response = await request(app.server)
          .get(path())
          .set(owner.headers)
          .expect(200);
        expect(response.body).toMatchObject({
          vulnerability: {
            id: findingId,
            firstSeen: { runId: first },
            lastSeen: { runId: last },
          },
          runs: [
            { id: first, sighting: 'seen' },
            { id: unknown, sighting: 'unknown' },
            { id: observed, sighting: 'seen' },
            { id: last, sighting: 'seen' },
            { id: sameTime, sighting: 'unknown' },
            { id: missed, sighting: 'missed' },
          ],
        });
        const { runs } = response.body as { runs: Record<string, unknown>[] };
        expect(Object.keys(runs[0]).sort()).toEqual([
          'createdAt',
          'id',
          'sighting',
          'workflowName',
        ]);
        expect(typeof runs[0].createdAt).toBe('string');
      });

      it('retains history for an archived finding after losing a last-run reference', async () => {
        await app.dataSource.query(
          'UPDATE vulnerabilities SET "isArchived"=true WHERE id=$1',
          [findingId],
        );
        await app.dataSource.query(
          'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=NULL WHERE id=$1',
          [timelineLink],
        );
        try {
          const response = await request(app.server)
            .get(path())
            .set(owner.headers)
            .expect(200);
          expect(response.body).toMatchObject({
            vulnerability: {
              id: findingId,
              firstSeen: { runId: first },
              lastSeen: { runId: null },
            },
            runs: [
              { id: first, sighting: 'seen' },
              { id: unknown, sighting: 'unknown' },
              { id: observed, sighting: 'seen' },
              { id: last, sighting: 'unknown' },
              { id: sameTime, sighting: 'unknown' },
              { id: missed, sighting: 'missed' },
            ],
          });
        } finally {
          await app.dataSource.query(
            'UPDATE vulnerabilities SET "isArchived"=false WHERE id=$1',
            [findingId],
          );
          await app.dataSource.query(
            'UPDATE project_vulnerabilities SET "lastSeenJobHistoryId"=$1 WHERE id=$2',
            [last, timelineLink],
          );
        }
      });

      it('requires valid IDs, authentication, and a finding in the caller’s project', async () => {
        await request(app.server)
          .get(path('invalid'))
          .set(owner.headers)
          .expect(400);
        await request(app.server)
          .get(path(timelineProject, 'invalid'))
          .set(owner.headers)
          .expect(400);
        await request(app.server)
          .get(path())
          .set('X-Workspace-Id', owner.workspace.id)
          .expect(401);
        await request(app.server)
          .get(path())
          .set({ ...owner.headers, 'X-Workspace-Id': other.workspace.id })
          .expect(403);
        await request(app.server).get(path()).set(other.headers).expect(404);
        await request(app.server)
          .get(path(sibling))
          .set(owner.headers)
          .expect(404);
        await request(app.server)
          .get(path(timelineProject, randomUUID()))
          .set(owner.headers)
          .expect(404);
      });
    });
  });
});
