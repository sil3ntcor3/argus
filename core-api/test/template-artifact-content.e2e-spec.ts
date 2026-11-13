import { ARTIFACT_BUCKET, workspaceArtifactUploadKey } from '@/common/constants/artifact-storage';
import { ArtifactBufferService } from '@/modules/artifacts/artifact-buffer.service';
import { ArtifactCleanupService } from '@/modules/artifacts/artifact-cleanup.service';
import { ArtifactQuotaService } from '@/modules/artifacts/artifact-quota.service';
import { ArtifactReadService } from '@/modules/artifacts/artifact-read.service';
import { TEMPLATE_REVISION_GRACE_MS, TemplateRevisionSweepService } from '@/modules/artifacts/template-revision-sweep.service';
import { TEMPLATE_RETIREMENTS_KEY } from '@/modules/artifacts/template-retirements';
import { ArtifactFolder } from '@/modules/artifacts/entities/artifact-folder.entity';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import { WorkspaceStorageUsage } from '@/modules/artifacts/entities/workspace-storage-usage.entity';
import { StorageService } from '@/modules/storage/storage.service';
import { TemplateArtifactService } from '@/modules/templates/template-artifact.service';
import { Workspace } from '@/modules/workspaces/entities/workspace.entity';
import { randomUUID } from 'node:crypto';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';

describe('Private template content storage (e2e)', () => {
  let app: TestApp;
  let writer: TemplateArtifactService;
  let storage: StorageService;
  let workspaceId: string;
  let userId: string;
  const original = 'id: argus-fixture\n# Résumé 🔒\n';
  const repo = () => app.dataSource.getRepository(WorkspaceArtifact);
  const usage = () => app.dataSource.getRepository(WorkspaceStorageUsage).findOneBy({ workspaceId });
  const input = (content = original) => ({ workspaceId, userId, name: 'local-check.yaml', content });
  const replace = (artifactId: string, content: string) => ({ workspaceId, userId, artifactId, content });
  const future = () => new Date(Date.now() + 1000);
  async function read(key: string) {
    const { file } = await storage.getFile(key, ARTIFACT_BUCKET);
    const chunks: Buffer[] = [];
    for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  }
  async function observe() {
    await app.app.get(TemplateRevisionSweepService).sweepPage(new Date(Date.now() - TEMPLATE_REVISION_GRACE_MS));
  }

  beforeAll(async () => {
    app = await createTestApp();
    writer = app.app.get(TemplateArtifactService);
    storage = app.app.get(StorageService);
  });
  beforeEach(async () => {
    [workspaceId] = (await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspaces(name) VALUES($1) RETURNING id', ['Template writer ' + randomUUID()],
    )).map(row => row.id);
    [userId] = (await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO users(name,email,"emailVerified") VALUES($1,$2,true) RETURNING id', ['Author', randomUUID() + '@example.test'],
    )).map(row => row.id);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    // This fixture has stopped its own writers before deleting its exact prefix.
    await storage.deleteWorkspaceArtifacts(workspaceId);
    await app.dataSource.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    await app.dataSource.query('DELETE FROM users WHERE id=$1', [userId]);
  });
  afterAll(async () => { if (app) await closeTestApp(app.app); });

  it('creates exact private YAML bytes, settles quota and serializes reserved folder creation', async () => {
    const files = await Promise.all([writer.create(input()), writer.create(input('id: second\n'))]);
    expect(await app.dataSource.getRepository(ArtifactFolder).countBy({ workspaceId, name: 'custom-templates' })).toBe(1);
    for (const file of files) {
      expect(file).toMatchObject({ workspaceId, createdByUserId: userId, source: 'template', status: 'ready', shareType: 'private' });
      expect(file.parentFolderId).toBe(files[0].parentFolderId);
    }
    expect(await read(files[0].objectKey)).toBe(original);
    expect(await usage()).toMatchObject({ usedBytes: String(Buffer.byteLength(original + 'id: second\n')), reservedBytes: '0' });
    await storage.uploadFile(workspaceArtifactUploadKey(workspaceId, files[0].id), Buffer.from('id: replay'), ARTIFACT_BUCKET, 'application/yaml');
    expect(await read(files[0].objectKey)).toBe(original);
  });

  it.each([{ name: 'invalid.txt' }, { content: 'id: 42' }, { content: 'id: a\n#' + 'x'.repeat(256 * 1024) }])('rejects invalid input before allocating files or quota', async invalid => {
    await expect(writer.create({ ...input(), ...invalid })).rejects.toThrow();
    expect(await repo().countBy({ workspaceId })).toBe(0);
    expect(await usage()).toBeNull();
  });

  it('retains a charged pending record when the initial object upload fails', async () => {
    jest.spyOn(storage, 'uploadFile').mockRejectedValueOnce(new Error('Local fixture outage'));
    await expect(writer.create(input())).rejects.toThrow('Local fixture outage');
    const file = await repo().findOneByOrFail({ workspaceId });
    expect(file).toMatchObject({ source: 'template', status: 'pending' });
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: String(Buffer.byteLength(original)) });
    await repo().update(file.id, { expiresAt: new Date(Date.now() - 20 * 60_000) });
    await app.app.get(ArtifactCleanupService).reclaim({ workspaceId, artifactId: file.id });
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: '0' });
  });

  it('edits through immutable keys, retains identity/sharing and keeps issued URLs readable', async () => {
    const file = await writer.create(input());
    await repo().update(file.id, { shareType: 'shared' });
    const { url } = await app.app.get(ArtifactReadService).getDownloadUrl(workspaceId, userId, file.id);
    const content = 'id: edited\n# longer content for quota accounting\n';
    const edited = await writer.replaceContent(replace(file.id, content));
    expect(edited).toMatchObject({ id: file.id, name: file.name, createdByUserId: userId, shareType: 'shared' });
    expect(edited.objectKey).toMatch(new RegExp(`^workspaces/${workspaceId}/${file.id}/revisions/[a-f0-9-]{36}$`));
    expect(await read(edited.objectKey)).toBe(content);
    expect(await (await fetch(url)).text()).toBe(original);
    expect(await usage()).toMatchObject({ usedBytes: String(Buffer.byteLength(content)), reservedBytes: '0' });
  });

  it('refuses to overwrite a revision key even if a caller repeats its UUID', async () => {
    const file = await writer.create(input());
    const options = { workspaceId, artifactId: file.id, revisionId: randomUUID(), buffer: Buffer.from(original), contentType: 'application/yaml' };
    const key = await storage.publishArtifactRevision(options);
    await expect(storage.publishArtifactRevision({ ...options, buffer: Buffer.from('id: overwritten') }))
      .rejects.toMatchObject({ status: 409 });
    expect(await read(key)).toBe(original);
  });

  it('rejects quota growth and allows shrinking after an administrator lowers the limit', async () => {
    const file = await writer.create(input());
    await app.dataSource.transaction(manager => app.app.get(ArtifactQuotaService).setQuota(manager, workspaceId, 0));
    await expect(writer.replaceContent(replace(file.id, original + '# more'))).rejects.toMatchObject({ status: 409 });
    expect((await repo().findOneByOrFail({ id: file.id })).objectKey).toBe(file.objectKey);
    await writer.replaceContent(replace(file.id, 'id: a'));
    expect(await usage()).toMatchObject({ usedBytes: '5', reservedBytes: '0', quotaBytes: '0' });
  });

  it('serializes concurrent edits without double charging or overwriting earlier revisions', async () => {
    const file = await writer.create(input());
    const contents = ['id: concurrent-a\n', 'id: concurrent-b\n# extra bytes\n'];
    const edited = await Promise.all(contents.map(content => writer.replaceContent(replace(file.id, content))));
    const current = await repo().findOneByOrFail({ id: file.id });
    expect(new Set(edited.map(row => row.objectKey)).size).toBe(2);
    for (let index = 0; index < edited.length; index++) expect(await read(edited[index].objectKey)).toBe(contents[index]);
    expect(await usage()).toMatchObject({ usedBytes: String(Buffer.byteLength(await read(current.objectKey))), reservedBytes: '0' });
  });

  it('rolls back a failed publication and safely reclaims its abandoned revision', async () => {
    const file = await writer.create(input());
    const abort = new AbortController();
    const publish = storage.publishArtifactRevision.bind(storage) as StorageService['publishArtifactRevision'];
    jest.spyOn(storage, 'publishArtifactRevision').mockImplementationOnce(async options => {
      const key = await publish(options);
      abort.abort(new Error('Stopped after upload'));
      return key;
    });
    await expect(writer.replaceContent({ ...replace(file.id, original + '# new'), abortSignal: abort.signal })).rejects.toThrow('Stopped');
    expect((await repo().findOneByOrFail({ id: file.id })).objectKey).toBe(file.objectKey);
    expect(await usage()).toMatchObject({ usedBytes: String(Buffer.byteLength(original)), reservedBytes: '0' });
    await observe();
    await app.app.get(TemplateRevisionSweepService).sweepPage(future());
    const { objects } = await storage.listArtifactSweepPage();
    expect(objects.filter(row => row.Key?.startsWith(`workspaces/${workspaceId}/${file.id}/revisions/`))).toHaveLength(0);
    expect(await read(file.objectKey)).toBe(original);
  });

  it('keeps recently retired content and current content, then cleans old revisions after the grace', async () => {
    const file = await writer.create(input());
    const edited = await writer.replaceContent(replace(file.id, 'id: current\n'));
    const updatedAt = edited.updatedAt.getTime();
    await observe();
    expect(await read(file.objectKey)).toBe(original);
    await app.app.get(TemplateRevisionSweepService).sweepPage(future());
    await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
    expect(await read(edited.objectKey)).toBe('id: current\n');
    expect((await repo().findOneByOrFail({ id: file.id })).updatedAt.getTime()).toBe(updatedAt);
  });

  it('expires older revisions while newer edits continue without resetting their retirement', async () => {
    const file = await writer.create(input());
    const middle = await writer.replaceContent(replace(file.id, 'id: middle\n'));
    await observe();
    const current = await writer.replaceContent(replace(file.id, 'id: newest\n'));
    await app.app.get(TemplateRevisionSweepService).sweepPage(future());
    await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
    expect(await read(middle.objectKey)).toBe('id: middle\n');
    expect(await read(current.objectKey)).toBe('id: newest\n');
  });

  it('retains failed deletions for retry without discarding their retirement records', async () => {
    const file = await writer.create(input());
    const current = await writer.replaceContent(replace(file.id, 'id: current\n'));
    await observe();
    jest.spyOn(storage, 'deleteArtifactSweepFailures').mockResolvedValueOnce([file.objectKey]);
    const sweep = app.app.get(TemplateRevisionSweepService);
    await sweep.sweepPage(future());
    expect(await read(file.objectKey)).toBe(original);
    expect((await repo().findOneByOrFail({ id: file.id })).metadata[TEMPLATE_RETIREMENTS_KEY]).toHaveProperty('file');
    await sweep.sweepPage(future());
    await expect(storage.headObject(ARTIFACT_BUCKET, file.objectKey)).rejects.toMatchObject({ status: 404 });
    expect(await read(current.objectKey)).toBe('id: current\n');
  });

  it('preserves content and rejects edits when private retirement metadata is malformed', async () => {
    const file = await writer.create(input());
    const current = await writer.replaceContent(replace(file.id, 'id: current\n'));
    await repo().update(file.id, { metadata: { [TEMPLATE_RETIREMENTS_KEY]: { '../another-file': '2000-01-01T00:00:00.000Z' } } });
    await expect(writer.replaceContent(replace(file.id, 'id: denied'))).rejects.toMatchObject({ status: 409 });
    await app.app.get(TemplateRevisionSweepService).sweepPage(future());
    expect(await read(file.objectKey)).toBe(original);
    expect(await read(current.objectKey)).toBe('id: current\n');
  });

  it('skips cleanup while a publisher holds its workspace lock', async () => {
    const file = await writer.create(input());
    await writer.replaceContent(replace(file.id, 'id: current\n'));
    await observe();
    const runner = app.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.manager.findOne(Workspace, { where: { id: workspaceId }, lock: { mode: 'for_key_share' } });
      await app.app.get(TemplateRevisionSweepService).sweepPage(future());
      expect(await read(file.objectKey)).toBe(original);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('does not edit another owner, workspace, source, or a deleted file', async () => {
    const file = await writer.create(input());
    for (const invalid of [{ userId: randomUUID() }, { workspaceId: randomUUID() }]) {
      await expect(writer.replaceContent({ ...replace(file.id, 'id: denied'), ...invalid })).rejects.toMatchObject({ status: 404 });
    }
    const agent = await app.app.get(ArtifactBufferService).createAgentFile({ workspaceId, userId, name: 'agent.yaml', buffer: Buffer.from(original), contentType: 'application/yaml' });
    await expect(writer.replaceContent(replace(agent.id, 'id: denied'))).rejects.toMatchObject({ status: 404 });
    await repo().update(file.id, { status: 'deleted' });
    await expect(writer.replaceContent(replace(file.id, 'id: denied'))).rejects.toMatchObject({ status: 404 });
    await app.app.get(ArtifactCleanupService).purgeDeleted({ workspaceId, artifactId: file.id });
    expect(await read(agent.objectKey)).toBe(original);
  });

  it('removes current bytes before releasing a deleted template charge, and requires audit proof for leftovers', async () => {
    const file = await writer.create(input());
    const retired = await writer.replaceContent(replace(file.id, 'id: retired\n'));
    const current = await writer.replaceContent(replace(file.id, 'id: current\n'));
    await app.app.get(ArtifactCleanupService).remove({ workspaceId, artifactId: file.id }, userId, ['artifact.write']);
    expect(await repo().findOneBy({ id: file.id })).toBeNull();
    expect(await usage()).toMatchObject({ usedBytes: '0', reservedBytes: '0' });
    await expect(storage.headObject(ARTIFACT_BUCKET, current.objectKey)).rejects.toMatchObject({ status: 404 });
    const sweep = app.app.get(TemplateRevisionSweepService);
    await sweep.sweepPage(future());
    expect(await read(retired.objectKey)).toBe('id: retired\n');
    await app.dataSource.query(
      `INSERT INTO audit_events ("eventId","workspaceId","resourceId","resourceType",action,outcome)
       VALUES ($1,$2,$3,'artifact','artifact.deleted','success')`, [randomUUID(), workspaceId, file.id],
    );
    await sweep.sweepPage(future());
    await expect(storage.headObject(ARTIFACT_BUCKET, retired.objectKey)).rejects.toMatchObject({ status: 404 });
  });
});
