import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { Template } from '@/modules/templates/entities/templates.entity';
import { LegacyTemplateImportService } from '@/modules/templates/legacy-template-import.service';
import { TemplateArtifactService } from '@/modules/templates/template-artifact.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('lossless legacy template import (Docker e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let storage: StorageService;
  const ids: string[] = [];
  const yaml = 'id: legacy-argus\n# preserve exact bytes\n';
  const legacy = async (content = yaml, name = 'legacy.yaml') => {
    const id = randomUUID(); ids.push(id);
    await storage.uploadFile(`${id}.yaml`, Buffer.from(content), 'nuclei-templates', 'application/yaml');
    await app.dataSource.getRepository(Template).save({ id, fileName: name, path: `nuclei-templates/${id}.yaml`, workspace: { id: owner.workspace.id } });
    return id;
  };
  const run = (apply = false) => app.app.get(LegacyTemplateImportService).run({ workspaceId: owner.workspace.id, apply });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'legacy-template-import');
    storage = app.app.get(StorageService);
  });
  afterEach(async () => {
    await storage.deleteWorkspaceArtifacts(owner.workspace.id);
    for (const id of ids.splice(0)) await storage.deleteFile(`${id}.yaml`, 'nuclei-templates');
    await app.dataSource.query('DELETE FROM artifacts WHERE "workspaceId"=$1', [owner.workspace.id]);
    await app.dataSource.query('DELETE FROM templates WHERE "workspaceId"=$1', [owner.workspace.id]);
    await app.dataSource.query('DELETE FROM artifact_folders WHERE "workspaceId"=$1', [owner.workspace.id]);
    await app.dataSource.query('DELETE FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id]);
  });
  afterAll(async () => {
    if (app) { await cleanupE2eData(app.dataSource, { workspaceIds: [owner.workspace.id], userIds: [owner.user.userId] }); await closeTestApp(app.app); }
  });

  it.each([yaml, '\uFEFF' + yaml])('dry-runs without allocating, then preserves identity/name/bytes and legacy data (case %#)', async original => {
    const id = await legacy(original);
    expect(await run()).toEqual([expect.objectContaining({ id, status: 'eligible' })]);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ workspaceId: owner.workspace.id })).toBe(0);
    expect(await run(true)).toEqual([expect.objectContaining({ id, status: 'imported' })]);
    const file = await app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id });
    expect(file).toMatchObject({ id, name: 'legacy.yaml', createdByUserId: owner.user.userId, source: 'template', status: 'ready', shareType: 'private' });
    const signed = await storage.getPresignedDownloadUrl({ bucket: ARTIFACT_BUCKET, key: file.objectKey });
    expect(Buffer.from(await (await fetch(signed.url)).arrayBuffer())).toEqual(Buffer.from(original));
    expect(await app.dataSource.getRepository(Template).countBy({ id })).toBe(1);
    expect((await storage.headObject('nuclei-templates', `${id}.yaml`)).contentLength).toBe(Buffer.byteLength(original));
  });

  it('is idempotent and never overwrites user edits or changed originals', async () => {
    const id = await legacy(); await run(true);
    await app.app.get(TemplateArtifactService).replaceContent({ workspaceId: owner.workspace.id, userId: owner.user.userId, artifactId: id, content: 'id: edited\n' });
    expect(await run(true)).toEqual([expect.objectContaining({ id, status: 'already_imported' })]);
    await storage.uploadFile(`${id}.yaml`, Buffer.from('id: original-changed'), 'nuclei-templates', 'application/yaml');
    expect(await run(true)).toEqual([expect.objectContaining({ id, status: 'source_changed' })]);
    expect((await app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id })).sizeBytes).toBe(String(Buffer.byteLength('id: edited\n')));
  });

  it('reports invalid and missing originals without deleting them', async () => {
    const invalid = await legacy('id: [');
    const missing = await legacy(); await storage.deleteFile(`${missing}.yaml`, 'nuclei-templates');
    const result = await run(true);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: invalid, status: 'invalid' }), expect.objectContaining({ id: missing, status: 'unavailable' })]));
    expect(await app.dataSource.getRepository(Template).countBy({ workspace: { id: owner.workspace.id } })).toBe(2);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ workspaceId: owner.workspace.id })).toBe(0);
  });

  it('serializes concurrent importers without duplicate byte accounting', async () => {
    const id = await legacy();
    await Promise.all([run(true), run(true)]);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ id })).toBe(1);
    const [meter] = await app.dataSource.query<{ usedBytes: string; reservedBytes: string }[]>('SELECT "usedBytes","reservedBytes" FROM workspace_storage_usage WHERE "workspaceId"=$1', [owner.workspace.id]);
    expect(meter).toEqual({ usedBytes: String(Buffer.byteLength(yaml)), reservedBytes: '0' });
  });

  it('never recreates a template deleted after import', async () => {
    const id = await legacy(); await run(true);
    await request(app.server).delete(`/api/artifacts/${id}`).set(owner.headers).expect(200);
    expect(await run(true)).toEqual([expect.objectContaining({ id, status: 'previous_import_attempt' })]);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ id })).toBe(0);
    expect(await app.dataSource.getRepository(Template).countBy({ id })).toBe(1);
  });
});
