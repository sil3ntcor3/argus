import { ARTIFACT_BUCKET } from '@/common/constants/artifact-storage';
import { WorkspaceArtifact } from '@/modules/artifacts/entities/workspace-artifact.entity';
import type { ArtifactListItemDto } from '@/modules/artifacts/dto/artifact-list.dto';
import { StorageService } from '@/modules/storage/storage.service';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { closeTestApp, createTestApp, type TestApp } from './helpers/app';
import { cleanupE2eData, createUserWithWorkspace } from './helpers/workspace';

describe('Artifact-backed Templates API (e2e)', () => {
  let app: TestApp;
  let owner: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  let reader: Awaited<ReturnType<typeof createUserWithWorkspace>>;
  const content = 'id: argus-local-check\ninfo:\n  name: Local fixture\n';
  const create = async (data = { name: 'local-check.yaml', content }) => {
    const response = await request(app.server).post('/api/templates').set(owner.headers).send(data).expect(201);
    return { body: response.body as ArtifactListItemDto };
  };
  const readerHeaders = () => ({ ...reader.headers, 'X-Workspace-Id': owner.workspace.id });

  beforeAll(async () => {
    app = await createTestApp();
    owner = await createUserWithWorkspace(app.server, 'templates-owner');
    reader = await createUserWithWorkspace(app.server, 'templates-reader');
    const [member] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_members("workspaceId","userId") VALUES($1,$2) RETURNING id', [owner.workspace.id, reader.user.userId],
    );
    const [group] = await app.dataSource.query<{ id: string }[]>(
      'INSERT INTO workspace_permissions("workspaceId",name,permissions) VALUES($1,$2,$3) RETURNING id',
      [owner.workspace.id, 'Template reader', ['artifact.read']],
    );
    await app.dataSource.query('INSERT INTO workspace_member_permissions("memberId","permissionId") VALUES($1,$2)', [member.id, group.id]);
  });
  afterEach(async () => {
    for (const workspaceId of [owner.workspace.id, reader.workspace.id]) {
      await app.app.get(StorageService).deleteWorkspaceArtifacts(workspaceId);
      await app.dataSource.query('DELETE FROM artifacts WHERE "workspaceId"=$1', [workspaceId]);
      await app.dataSource.query('DELETE FROM artifact_folders WHERE "workspaceId"=$1', [workspaceId]);
      await app.dataSource.query('DELETE FROM workspace_storage_usage WHERE "workspaceId"=$1', [workspaceId]);
    }
  });
  afterAll(async () => {
    if (app) {
      await cleanupE2eData(app.dataSource, {
        workspaceIds: [owner?.workspace.id, reader?.workspace.id].filter(Boolean),
        userIds: [owner?.user.userId, reader?.user.userId].filter(Boolean),
      });
      await closeTestApp(app.app);
    }
  });

  it('creates private validated YAML and lists safe artifact metadata', async () => {
    const created = await create();
    expect(created.body).toMatchObject({ name: 'local-check.yaml', source: 'template', isOwner: true, shareType: 'private', sizeBytes: Buffer.byteLength(content) });
    expect(Object.keys(created.body.createdBy ?? {}).sort()).toEqual(['id', 'image', 'name']);
    expect(created.body).not.toHaveProperty('objectKey');
    const list = await request(app.server).get('/api/templates?scope=mine&search=local-check').set(owner.headers).expect(200);
    expect((list.body as { data: ArtifactListItemDto[] }).data).toEqual([expect.objectContaining({ id: created.body.id, name: 'local-check.yaml' })]);
    await request(app.server).get('/api/templates').set('X-Workspace-Id', owner.workspace.id).expect(401);
    const read = await request(app.server).get(`/api/templates/${created.body.id}/content`).set(owner.headers).expect(200);
    expect(read.body).toMatchObject({ content, artifact: { id: created.body.id, isOwner: true } });
    expect((read.body as { artifact: ArtifactListItemDto }).artifact).not.toHaveProperty('metadata');
  });

  it('retains identity and prior signed bytes when saving, and renames independently', async () => {
    const { body: file } = await create();
    const download = await request(app.server).get(`/api/artifacts/${file.id}/download`).set(owner.headers).expect(200);
    const saved = await request(app.server).put(`/api/templates/${file.id}/content`).set(owner.headers).send({ content: 'id: edited\n' }).expect(200);
    expect((saved.body as ArtifactListItemDto).id).toBe(file.id);
    expect(await (await fetch((download.body as { url: string }).url)).text()).toBe(content);
    const renamed = await request(app.server).patch(`/api/templates/${file.id}`).set(owner.headers).send({ name: ' renamed.yml ' }).expect(200);
    expect(renamed.body).toMatchObject({ id: file.id, name: 'renamed.yml' });
    const read = await request(app.server).get(`/api/templates/${file.id}/content`).set(owner.headers).expect(200);
    expect((read.body as { content: string }).content).toBe('id: edited\n');
  });

  it('requires current sharing access and prevents writes by recipients', async () => {
    const { body: file } = await create();
    await request(app.server).get(`/api/templates/${file.id}/content`).set(readerHeaders()).expect(404);
    await request(app.server).post(`/api/artifacts/${file.id}/shares`).set(owner.headers).send({ emails: [reader.user.email] }).expect(201);
    await request(app.server).patch(`/api/artifacts/${file.id}`).set(owner.headers).send({ shareType: 'shared' }).expect(200);
    await request(app.server).get(`/api/templates/${file.id}/content`).set(readerHeaders()).expect(200);
    const shared = await request(app.server).get('/api/templates?scope=shared').set(readerHeaders()).expect(200);
    expect((shared.body as { data: ArtifactListItemDto[] }).data).toEqual([expect.objectContaining({ id: file.id, isOwner: false })]);
    await request(app.server).put(`/api/templates/${file.id}/content`).set(readerHeaders()).send({ content }).expect(403);
    await request(app.server).patch(`/api/templates/${file.id}`).set(readerHeaders()).send({ name: 'denied.yaml' }).expect(403);
    await request(app.server).delete(`/api/artifacts/${file.id}/shares/${reader.user.userId}`).set(owner.headers).expect(200);
    await request(app.server).get(`/api/templates/${file.id}/content`).set(readerHeaders()).expect(404);
  });

  it('supports public templates only inside the selected workspace and hides non-template artifacts', async () => {
    const { body: file } = await create();
    await request(app.server).patch(`/api/artifacts/${file.id}`).set(owner.headers).send({ shareType: 'public' }).expect(200);
    await request(app.server).get(`/api/templates/${file.id}/content`).set(readerHeaders()).expect(200);
    await request(app.server).get(`/api/templates/${file.id}/content`).set(reader.headers).expect(404);
    await app.dataSource.getRepository(WorkspaceArtifact).update(file.id, { source: 'agent' });
    await request(app.server).get(`/api/templates/${file.id}/content`).set(owner.headers).expect(404);
    await request(app.server).get('/api/templates?scope=mine').set(owner.headers).expect(200).expect(response => expect((response.body as { data: ArtifactListItemDto[] }).data).toEqual([]));
  });

  it('keeps pending, deleted and foreign records inaccessible', async () => {
    const { body: file } = await create();
    await request(app.server).get(`/api/templates/${randomUUID()}/content`).set(owner.headers).expect(404);
    await request(app.server).get('/api/templates/not-a-uuid/content').set(owner.headers).expect(400);
    await request(app.server).delete(`/api/artifacts/${file.id}`).set(owner.headers).expect(200);
    await request(app.server).get(`/api/templates/${file.id}/content`).set(owner.headers).expect(404);
    const usage = await request(app.server).get('/api/artifacts/usage').set(owner.headers).expect(200);
    expect((usage.body as { usedBytes: number }).usedBytes).toBe(0);
  });

  it.each([
    { name: 'invalid.txt', content }, { name: 'valid.yaml', content: 'id: 1' },
    { name: 'valid.yaml', content: 'id: a\nid: b' }, { name: 'valid.yaml', content: 'id: [' },
    { name: 'valid.yaml', content: 'id: " "' },
  ])('rejects invalid YAML or a non-template name', async data => {
    await request(app.server).post('/api/templates').set(owner.headers).send(data).expect(400);
    expect(await app.dataSource.getRepository(WorkspaceArtifact).countBy({ workspaceId: owner.workspace.id })).toBe(0);
  });

  it('enforces the byte boundary and quota without allocating invalid files', async () => {
    const prefix = 'id: boundary\n#';
    const exact = prefix + 'x'.repeat(256 * 1024 - Buffer.byteLength(prefix));
    const created = await create({ name: 'boundary.yaml', content: exact });
    expect(created.body.sizeBytes).toBe(256 * 1024);
    await request(app.server).post('/api/templates').set(owner.headers).send({ name: 'too-big.yaml', content: exact + 'x' }).expect(413);
    await app.dataSource.query('UPDATE workspace_storage_usage SET "quotaBytes"=0 WHERE "workspaceId"=$1', [owner.workspace.id]);
    await request(app.server).post('/api/templates').set(owner.headers).send({ name: 'quota.yaml', content }).expect(409);
    await request(app.server).put(`/api/templates/${created.body.id}/content`).set(owner.headers).send({ content: 'id: shrink' }).expect(200);
    const artifact = await app.dataSource.getRepository(WorkspaceArtifact).findOneByOrFail({ id: created.body.id });
    expect((await app.app.get(StorageService).headObject(ARTIFACT_BUCKET, artifact.objectKey)).contentLength).toBe(Buffer.byteLength('id: shrink'));
  });
});
