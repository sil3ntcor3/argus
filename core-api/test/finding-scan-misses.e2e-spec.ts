import { EventTriggerType } from '@/common/enums/enum';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Private comparable scan misses (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let workflow: string;
  let foreign: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let foreignWorkflow: string;
  let tool: string;
  let asset: string;
  const legacyScope = 'a'.repeat(64);
  const scope = 'image-v1:' + legacyScope;
  const observedAt = new Date('2026-11-09T12:00:00.000Z');
  const after = new Date('2026-11-09T13:00:00.000Z');

  async function insert(sql: string, params: unknown[]) {
    const [row] = await app.dataSource.query<{ id: string }[]>(sql + ' RETURNING id', params);
    return row.id;
  }

  const run = (completed = true, workflowId = workflow) => insert(
    'INSERT INTO job_histories ("workflowId","isCompleted") VALUES ($1,$2)',
    [workflowId, completed],
  );

  async function scan(
    history: string,
    {
      key = scope, at = after, covered = true, status = 'completed',
    }: { key?: string; at?: Date; covered?: boolean | null; status?: string } = {},
  ) {
    return insert(
      `INSERT INTO jobs ("jobHistoryId","assetId","toolId",category,status,
        "findingScanScopeKey","findingScanClaimedAt","findingScanCoverageComplete")
       VALUES ($1,$2,$3,'vulnerabilities',$4,$5,$6,$7)`,
      [history, asset, tool, status, key, at, covered],
    );
  }

  const finding = (seen: Date | null, archived = false, key = scope) => insert(
    `INSERT INTO vulnerabilities (name, severity, "assetId", "toolId", "scanScopeKey",
        "lastScannerObservedAt","isArchived") VALUES ($1,'high',$2,$3,$4,$5,$6)`,
    [randomUUID(), asset, tool, key, seen, archived],
  );

  const completed = async (id: string) => {
    await app.app.get(EventEmitter2).emitAsync(EventTriggerType.WORKFLOW_END, {
      jobHistory: { id },
    });
  };

  const state = async (id: string) => {
    const [row] = await app.dataSource.query<{ missedScans: number; detectionStatus: string }[]>(
      'SELECT "missedScans","detectionStatus" FROM vulnerabilities WHERE id=$1',
      [id],
    );
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'finding-scan-misses');
    const host = randomUUID() + '.example.test';
    const target = await insert(
      `INSERT INTO targets (value,type,"workspaceId") VALUES ($1,'DOMAIN',$2)`,
      [host, owner.workspace.id],
    );
    asset = await insert('INSERT INTO assets (value,"targetId") VALUES ($1,$2)', [host, target]);
    tool = await insert('INSERT INTO tools (name,categories) VALUES ($1,$2)', [
      randomUUID(),
      JSON.stringify([{ name: 'vulnerabilities', targetTypes: ['DOMAIN'] }]),
    ]);
    const makeWorkflow = (workspaceId: string) => insert(
      `INSERT INTO workflows (name,content,"filePath","workspaceId") VALUES ($1,'{}',$1,$2)`,
      [randomUUID(), workspaceId],
    );
    workflow = await makeWorkflow(owner.workspace.id);
    foreign = await createUserWithWorkspace(app.server, 'finding-scan-misses-foreign');
    foreignWorkflow = await makeWorkflow(foreign.workspace.id);
  });

  afterAll(async () => {
    if (!app) return;
    try {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, foreign?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, foreign?.user.userId].filter(Boolean),
      });
      if (tool) await app.dataSource.query('DELETE FROM tools WHERE id=$1', [tool]);
    } finally {
      await closeTestApp(app.app);
    }
  });

  it('does not count tag-only coverage from a worker without immutable image evidence', async () => {
    const legacy = await finding(observedAt, false, legacyScope);
    const history = await run();
    await scan(history, { key: legacyScope });

    await completed(history);

    expect(await state(legacy)).toEqual({ missedScans: 0, detectionStatus: 'new' });
  });

  it('counts only distinct comparable completed runs and does not close findings', async () => {
    const current = await finding(observedAt);
    const unknown = await finding(null);
    const archived = await finding(observedAt, true);
    const dismissed = await finding(observedAt);
    await insert(
      `INSERT INTO vulnerability_dismissals ("vulnerabilityId","userId",reason,"expiresAt")
       VALUES ($1,$2,'risk_accepted',statement_timestamp() + interval '1 day')`,
      [dismissed, owner.user.userId],
    );
    const duplicate = await run();
    await scan(duplicate);
    await scan(duplicate);
    const positive = await run();
    await scan(positive);
    await insert(
      `INSERT INTO vulnerability_sources ("vulnerabilityId",kind,"toolId","jobHistoryId")
       VALUES ($1,'tool',$2,$3)`,
      [current, tool, positive],
    );
    await scan(await run(), { key: 'image-v1:' + 'b'.repeat(64) });
    await scan(await run(), { covered: null });
    await scan(await run(), { at: observedAt });
    await scan(await run(false));
    await scan(await run(true, foreignWorkflow));
    const cancelled = await run();
    await scan(cancelled);
    await scan(cancelled, { covered: null, status: 'cancelled' });
    const valid = await run();
    await scan(valid);

    await completed(valid);
    await completed(valid);

    expect(await state(current)).toEqual({ missedScans: 2, detectionStatus: 'new' });
    expect(await state(unknown)).toEqual({ missedScans: 0, detectionStatus: 'new' });
    expect(await state(archived)).toEqual({ missedScans: 0, detectionStatus: 'new' });
    expect(await state(dismissed)).toEqual({ missedScans: 0, detectionStatus: 'new' });
  });
});
