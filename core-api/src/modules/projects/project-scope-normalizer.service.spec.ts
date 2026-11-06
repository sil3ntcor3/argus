import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { BadRequestException } from '@nestjs/common';
import { ProjectScopeNormalizer } from './project-scope-normalizer.service';

const target = '3f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f';
const asset = '4f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f';
const include = (type: Kind, value: string) => ({
  mode: Mode.INCLUDE,
  type,
  value,
});
const setup = () => {
  const query = jest.fn();
  return { query, service: new ProjectScopeNormalizer({ query } as never) };
};

describe('ProjectScopeNormalizer', () => {
  it.each([
    include(Kind.CIDR, '10.0.0.0/40'),
    include(Kind.HOSTNAME, '*.argus.test;DROP'),
  ])('rejects invalid values before looking up references', async (rule) => {
    const { service, query } = setup();
    await expect(
      service.normalizeRules('workspace', [rule]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode before querying', async () => {
    const { service, query } = setup();
    await expect(
      service.normalizeRules('workspace', [
        { ...include(Kind.ASSET, asset), mode: 'invalid' as Mode },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('checks normalized target and asset UUIDs in two bounded workspace queries', async () => {
    const { service, query } = setup();
    query
      .mockResolvedValueOnce([{ id: target }])
      .mockResolvedValueOnce([{ id: asset }]);
    const result = await service.normalizeRules('workspace', [
      include(Kind.TARGET, target.toUpperCase()),
      include(Kind.ASSET, ` ${asset} `),
    ]);
    expect(result).toEqual([
      include(Kind.TARGET, target),
      include(Kind.ASSET, asset),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('"workspaceId" = $2');
    expect(query.mock.calls[0][1]).toEqual([[target], 'workspace']);
    expect(query.mock.calls[1][0]).toContain('JOIN targets');
    expect(query.mock.calls[1][0]).toContain('t."workspaceId" = $1');
    expect(query.mock.calls[1][1]).toEqual(['workspace', [asset]]);
  });

  it.each([
    [Kind.TARGET, target, 'Target'],
    [Kind.ASSET, asset, 'Asset'],
  ] as const)(
    'refuses a missing or foreign %s without returning its details',
    async (kind, id, label) => {
      const { service, query } = setup();
      query.mockResolvedValue([]);
      await expect(
        service.normalizeRules('workspace', [include(kind, id)]),
      ).rejects.toThrow(`${label} "${id}" not found`);
    },
  );

  it('deduplicates canonical triples while preserving modes and first-input order', async () => {
    const { service, query } = setup();
    query.mockResolvedValue([{ id: target }]);
    const hostname = include(Kind.HOSTNAME, '*.argus.test');
    expect(
      await service.normalizeRules('workspace', [
        include(Kind.HOSTNAME, '*.ARGUS.TEST '),
        hostname,
        { ...hostname, mode: Mode.EXCLUDE },
        include(Kind.TARGET, target.toUpperCase()),
        include(Kind.TARGET, target),
      ]),
    ).toEqual([
      hostname,
      { ...hostname, mode: Mode.EXCLUDE },
      include(Kind.TARGET, target),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[target], 'workspace']);
  });

  it('does not query for an empty rule set', async () => {
    const { service, query } = setup();
    expect(await service.normalizeRules('workspace', [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates infrastructure errors instead of reporting invalid user input', async () => {
    const { service, query } = setup(),
      error = new Error('database unavailable');
    query.mockRejectedValue(error);
    await expect(
      service.normalizeRules('workspace', [include(Kind.TARGET, target)]),
    ).rejects.toBe(error);
  });
});
