import { randomUUID } from 'node:crypto';
import { prepareSavedTemplates, SAVED_TEMPLATE_SELECTION } from './saved-template-dispatch';
import type { GetNextJobResult } from './dto/jobs-registry.dto';

describe('saved template dispatch', () => {
  const id = randomUUID();
  const actorId = randomUUID();
  const row = { id, objectKey: `workspaces/ws/artifacts/${id}/revisions/${randomUUID()}` };
  const builder = Object.fromEntries(['innerJoin', 'where', 'andWhere'].map(key => [key, jest.fn().mockReturnThis()]));
  const rows = jest.fn();
  const ds = { getRepository: () => ({ createQueryBuilder: () => ({ ...builder, getMany: rows }) }) } as any;
  const membership = jest.fn();
  const workspace = { getMembershipWithPermissions: membership } as any;
  const sign = jest.fn();
  const storage = { getTemplateWorkerDownloadUrl: sign } as any;
  const job = () => ({ workspaceId: 'ws', tool: { name: 'nuclei' }, inputs: { target: 'example.test', [SAVED_TEMPLATE_SELECTION]: JSON.stringify({ actorId, ids: [id] }) } }) as unknown as GetNextJobResult;

  beforeEach(() => {
    jest.clearAllMocks();
    rows.mockResolvedValue([row]);
    membership.mockResolvedValue({ permissionKeys: ['artifact.read', 'vulnerability.write'] });
    sign.mockResolvedValue({ url: 'https://storage.test/revision?signature=secret', expiresIn: 3600 });
  });

  it('signs the current immutable key after profile resolution without persisting URLs', async () => {
    const claim = job();
    const result = await prepareSavedTemplates(ds, workspace, storage, claim, { token: 'credential', customTemplates: [{ url: 'spoofed' }] });
    expect(result.config).toEqual({ token: 'credential', customTemplates: [{ url: 'https://storage.test/revision?signature=secret', cacheKey: expect.any(String) }] });
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ key: row.objectKey, expiresIn: 3600 }));
    expect(JSON.stringify(claim)).not.toContain('secret');
    expect(JSON.stringify(result.scopeConfig)).not.toContain('signature');
  });

  it.each(['revoked', 'missing', 'wrong-tool', 'malformed'])('fails closed for %s', async (kind) => {
    const claim = job();
    if (kind === 'revoked') membership.mockResolvedValue({ permissionKeys: ['artifact.read'] });
    if (kind === 'missing') rows.mockResolvedValue([]);
    if (kind === 'wrong-tool') claim.tool!.name = 'nmap';
    if (kind === 'malformed') claim.inputs![SAVED_TEMPLATE_SELECTION] = '{}';
    await expect(prepareSavedTemplates(ds, workspace, storage, claim, {})).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied selectors instead of running the builtin set', async () => {
    await expect(prepareSavedTemplates(ds, workspace, storage, { tool: { name: 'nuclei' } } as any, { customTemplateIds: [id] })).rejects.toThrow();
  });

  it('keeps ordinary connector dispatch unchanged', async () => {
    const config = { rate: 10 };
    expect(await prepareSavedTemplates(ds, workspace, storage, {} as any, config)).toEqual({ config, scopeConfig: config });
    expect(membership).not.toHaveBeenCalled();
  });
});
