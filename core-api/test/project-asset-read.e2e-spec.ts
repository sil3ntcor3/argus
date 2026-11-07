import { randomUUID } from 'node:crypto';
import {
  GetManyBaseQueryParams,
  SortOrder,
} from '@/common/dtos/get-many-base.dto';
import { ProjectAssetSource, Severity } from '@/common/enums/enum';
import { ProjectAssetReadService } from '@/modules/projects/project-asset-read.service';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private enriched project member reader (e2e)', () => {
  let app: TestApp, service: ProjectAssetReadService;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>,
    other: typeof owner;
  let project: string,
    foreign: string,
    otherProject: string,
    rule: string,
    runId: string;
  const assets: string[] = [],
    targets: string[] = [];
  const insert = async (sql: string, args: unknown[]) =>
    (
      await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', args)
    )[0].id;
  const query = (values: object = {}) =>
    Object.assign(new GetManyBaseQueryParams(), { sortBy: 'value', ...values });
  const read = (values: object = {}) =>
    service.list(project.toUpperCase(), owner.workspace.id, query(values));
  beforeAll(async () => {
    app = await createTestApp();
    service = app.app.get(ProjectAssetReadService);
    owner = await createUserWithWorkspace(app.server, 'member-read-owner');
    other = await createUserWithWorkspace(app.server, 'member-read-other');
    for (const context of [owner, other]) {
      const id = await insert(
        'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
        [randomUUID(), context.workspace.id],
      );
      if (context === owner) project = id;
      else foreign = id;
      const target = await insert(
        'INSERT INTO targets (value,type,"workspaceId") VALUES ($1,$2,$3)',
        ['member.argus.test', 'DOMAIN', context.workspace.id],
      );
      targets.push(target);
      for (const value of context === owner
        ? ['alpha', 'beta', 'gamma']
        : ['foreign'])
        assets.push(
          await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [
            value + '.member.argus.test',
            target,
          ]),
        );
    }
    otherProject = await insert(
      'INSERT INTO projects (name,"workspaceId") VALUES ($1,$2)',
      [randomUUID(), owner.workspace.id],
    );
    rule = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [project, 'include', 'target', targets[0].toUpperCase()],
    );
    const unsafe = await insert(
      'INSERT INTO project_scope_rules ("projectId",mode,type,value) VALUES ($1,$2,$3,$4)',
      [foreign, 'include', 'target', targets[1]],
    );
    for (const [i, id] of assets.entries())
      await app.dataSource.query(
        'INSERT INTO project_assets ("projectId","assetId",source,"scopeRuleId","createdAt") VALUES ($1,$2,$3,$4,$5)',
        [
          project,
          id,
          i === 0 ? 'manual' : 'rule',
          i === 1 ? rule : i === 2 ? unsafe : null,
          new Date('2026-01-0' + (i + 1) + 'T00:00:00Z'),
        ],
      );
    const workflows: string[] = [];
    for (const context of [owner, other])
      workflows.push(
        await insert(
          'INSERT INTO workflows (name,content,"filePath","workspaceId") VALUES ($1,$2,$3,$4)',
          [
            randomUUID(),
            JSON.stringify({ name: 'Argus synthetic', jobs: {} }),
            randomUUID() + '.yaml',
            context.workspace.id,
          ],
        ),
      );
    for (const [i, p] of [project, otherProject, project, null].entries()) {
      const id = await insert(
        'INSERT INTO job_histories ("workflowId","projectId",scope,"createdAt") VALUES ($1,$2,$3,$4)',
        [
          workflows[i === 2 ? 1 : 0],
          p,
          JSON.stringify({ assetIds: [assets[1]] }),
          new Date('2026-02-0' + (i + 1) + 'T00:00:00Z'),
        ],
      );
      if (i === 0) runId = id;
    }
    const severities = Object.values(Severity).reverse();
    for (const [i, severity] of [
      ...severities,
      ...severities.slice(0, 3),
      Severity.CRITICAL,
    ].entries()) {
      const id = await insert(
        'INSERT INTO vulnerabilities (name,severity,"assetId","isArchived") VALUES ($1,$2,$3,$4)',
        [randomUUID(), severity, assets[1], i === 5],
      );
      if (i !== 7)
        await app.dataSource.query(
          'INSERT INTO project_vulnerabilities ("projectId","vulnerabilityId","firstSeenAt","lastSeenAt") VALUES ($1,$2,now(),now())',
          [i === 8 ? otherProject : project, id],
        );
      if (i === 6)
        await app.dataSource.query(
          'INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason) VALUES ($1,$2,$3)',
          [id, owner.user.userId, 'used_in_test'],
        );
    }
  });
  afterAll(async () => {
    await cleanupE2eData(app.dataSource, {
      workspaceIds: [owner?.workspace.id, other?.workspace.id].filter(Boolean),
      userIds: [owner?.user.userId, other?.user.userId].filter(Boolean),
    });
    await closeTestApp(app.app);
  });
  it('returns target and rule reasons, null-safe provenance and only project/workspace-attributed scans', async () => {
    const result = await read();
    expect(result.total).toBe(3);
    expect(result.data.map((row) => row.id)).toEqual(assets.slice(0, 3));
    expect(result.data[0]).toMatchObject({
      source: 'manual',
      rule: null,
      lastScan: null,
      targetId: targets[0],
      targetValue: 'member.argus.test',
      targetType: 'DOMAIN',
    });
    expect(result.data[1]).toMatchObject({
      source: 'rule',
      rule: {
        id: rule,
        type: 'target',
        value: targets[0].toUpperCase(),
        label: 'member.argus.test',
      },
      lastScan: { runId },
    });
    expect(result.data[1].addedAt).toBeInstanceOf(Date);
    expect(result.data[1].lastScan?.createdAt).toBeInstanceOf(Date);
    expect(result.data[2].rule).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:workflowId|projectId|scopeRuleId|scope|inputs)"/,
    );
  });
  it('counts only open findings linked to this project, excluding archived, dismissed and unlinked findings', async () => {
    const result = await read();
    expect(result.data[1].vulnerabilities).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
      info: 1,
    });
    expect(result.data[0].vulnerabilities).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    });
  });
  it('filters source and search, pages deterministically and binds hostile search/sort strings', async () => {
    const result = await read({ source: ProjectAssetSource.RULE, limit: 1 });
    expect(result).toMatchObject({ total: 2, pageCount: 2, hasNextPage: true });
    expect(result.data[0].id).toBe(assets[1]);
    expect(
      (
        await read({ source: ProjectAssetSource.MANUAL, search: 'ALPHA' })
      ).data.map((row) => row.id),
    ).toEqual([assets[0]]);
    expect(
      (await read({ source: ProjectAssetSource.RULE, page: 2, limit: 1 }))
        .data[0].id,
    ).toBe(assets[2]);
    expect((await read({ page: 9 })).data).toEqual([]);
    expect(
      (await read({ sortBy: 'toString', sortOrder: SortOrder.DESC })).data.map(
        (row) => row.id,
      ),
    ).toEqual(assets.slice(0, 3).reverse());
    expect(
      (await read({ search: "' OR true--", sortBy: 'value DESC; --' })).total,
    ).toBe(0);
  });
  it('denies foreign/missing projects, rejects unsafe paging and preserves all membership state', async () => {
    for (const id of [foreign, randomUUID()])
      await expect(
        service.list(id, owner.workspace.id, query()),
      ).rejects.toMatchObject({ status: 404 });
    for (const values of [
      { page: 0 },
      { page: 1.5 },
      { limit: 0 },
      { limit: 101 },
    ])
      await expect(read(values)).rejects.toMatchObject({ status: 400 });
    const before = await app.dataSource.query(
      'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
      [project],
    );
    await read();
    expect(
      await app.dataSource.query(
        'SELECT * FROM project_assets WHERE "projectId"=$1 ORDER BY id',
        [project],
      ),
    ).toEqual(before);
  });
});
