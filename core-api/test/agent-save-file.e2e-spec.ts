import { AgentApprovalMode } from '@/common/enums/enum';
import { AgentTool } from '@/modules/agents/agents.tools';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import * as request from 'supertest';
import type { ToolCallOptions } from '@/modules/agents/tools/types';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

type FileTool = { inputSchema: z.ZodTypeAny; execute: (input: unknown, options: ToolCallOptions) => Promise<unknown> };

describe('Conversation save_file with Docker storage (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let outsider: typeof owner;
  const conversation = randomUUID();
  const files = () => app.dataSource.getRepository(WorkspaceArtifact).findBy({ workspaceId: owner.workspace.id });
  const tool = (gate = {}) => app.app.get(AgentTool).getArtifactTools(owner.workspace.id, owner.user.userId, conversation,
    { userId: owner.user.userId, mode: AgentApprovalMode.AUTO, ...gate }).save_file as FileTool;
  const execute = (params = { fileName: 'Tool report.txt', content: 'Résumé 🔒' }, options = {}) => {
    const selected = tool();
    return selected.execute(selected.inputSchema.parse(params), { toolCallId: randomUUID(), ...options });
  };

  beforeAll(async () => {
    app = await createTestApp();
    await app.app.listen(0);
    owner = await createUserWithWorkspace(app.server, 'save-file-owner');
    outsider = await createUserWithWorkspace(app.server, 'save-file-outsider');
  });
  afterAll(async () => {
    if (!app) return;
    try {
      if (owner) for (const file of await files()) await app.app.get(StorageService).deleteArtifactUploadObjects({ workspaceId: owner.workspace.id, artifactId: file.id });
      await cleanupE2eData(app.dataSource, { workspaceIds: [owner?.workspace.id, outsider?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, outsider?.user.userId].filter(Boolean) });
    } finally { await closeTestApp(app.app); }
  });

  it('makes a privately owned file visible and downloadable through the existing API', async () => {
    const result = await execute() as { id: string };
    expect(result).toEqual({ success: true, id: expect.any(String), name: 'Tool report.txt',
      sizeBytes: Buffer.byteLength('Résumé 🔒'), message: 'File saved to workspace Files.' });
    const row = await app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id: result.id });
    expect(row).toMatchObject({ source: 'agent', shareType: 'private', status: 'ready', createdByUserId: owner.user.userId });
    const listing = await request(app.server).get('/api/artifacts').set(owner.headers).expect(200);
    expect(listing.body.data).toEqual([expect.objectContaining({ id: result.id, source: 'agent' })]);
    await request(app.server).get(`/api/artifacts/${result.id}`).set(outsider.headers).expect(404);
    const download = await request(app.server).get(`/api/artifacts/${result.id}/download`).set(owner.headers).expect(200);
    expect(await (await fetch((download.body as { url: string }).url)).text()).toBe('Résumé 🔒');
    expect(await app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId: owner.workspace.id }))
      .toMatchObject({ usedBytes: String(Buffer.byteLength('Résumé 🔒')), reservedBytes: '0' });
  });

  it('rechecks permissions on an already-built tool before writing', async () => {
    const selected = tool();
    const before = (await files()).length;
    await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE "workspaceId"=$2', [['workspace.read', 'artifact.read'], owner.workspace.id]);
    try {
      await expect(selected.execute({ fileName: 'Denied.txt', content: 'denied' }, { toolCallId: randomUUID() }))
        .resolves.toMatchObject({ success: false, message: expect.stringContaining('artifact.write') });
      expect(await files()).toHaveLength(before);
    } finally {
      await app.dataSource.query('UPDATE workspace_permissions SET permissions=$1 WHERE "workspaceId"=$2', [['*'], owner.workspace.id]);
    }
  });

  it('preserves plan/todo gates and cancellation without creating a file', async () => {
    const before = (await files()).length;
    const input = { fileName: 'Blocked.txt', content: 'blocked' };
    const options = { toolCallId: randomUUID() };
    await expect(tool({ mode: AgentApprovalMode.PLAN, planFirst: true }).execute(input, options)).resolves.toHaveProperty('error');
    await expect(tool({ needsTodo: () => Promise.resolve(true) }).execute(input, options)).resolves.toHaveProperty('error');
    await expect(execute(input, { abortSignal: AbortSignal.abort(new Error('Stopped')) })).resolves.toMatchObject({ success: false });
    expect(await files()).toHaveLength(before);
  });
});
