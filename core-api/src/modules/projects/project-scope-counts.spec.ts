import {
  ProjectScopeRuleMode as Mode,
  ProjectScopeRuleType as Kind,
} from '@/common/enums/enum';
import { countScopeRules } from './project-scope-preview.service';
import type { ScopeRuleLike } from './scope-rules';

const owned = '3f1c2a8e-6c1b-4d5e-9f00-0a1b2c3d4e5f';
const excluded = (value: string): ScopeRuleLike => ({
  mode: Mode.EXCLUDE,
  type: Kind.ASSET,
  value,
});
const include: ScopeRuleLike = {
  mode: Mode.INCLUDE,
  type: Kind.HOSTNAME,
  value: '*.argus.test',
};

describe('Batched asset exclusion match counts', () => {
  it('uses two queries for an include and over 65,535 asset exclusions while retaining duplicate input indices', async () => {
    const query = jest
      .fn()
      .mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('a.id = ANY') ? [{ id: owned }] : [{ count: 2 }],
        ),
      );
    const bulk = Array.from({ length: 65_536 }, (_, i) =>
      excluded('00000000-0000-4000-8000-' + i.toString(16).padStart(12, '0')),
    );
    const counts = await countScopeRules({ query } as never, 'workspace', [
      include,
      ...bulk,
      excluded(owned),
      excluded(owned.toUpperCase()),
    ]);
    expect(query.mock.calls.length).toBe(2);
    expect(counts.length).toBe(65_539);
    expect(counts[0]).toBe(2);
    expect(counts.slice(-2)).toEqual([1, 1]);
    expect(counts.slice(1, -2).reduce((sum, value) => sum + value, 0)).toBe(0);
    const bindings = query.mock.calls[0][1] as unknown[];
    expect(bindings[0]).toBe('workspace');
    expect((bindings[1] as string[]).length).toBe(65_537);
    expect(bindings[2]).toBe('%.argus.test');
  });
  it('keeps non-asset exclusions in their original positions and preserves their individual counts', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: owned }])
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 1 }]);
    expect(
      await countScopeRules({ query } as never, 'workspace', [
        excluded(owned),
        include,
        { mode: Mode.EXCLUDE, type: Kind.HOSTNAME, value: 'manual.argus.test' },
        excluded(owned.toUpperCase()),
      ]),
    ).toEqual([1, 2, 1, 1]);
    expect(query.mock.calls.length).toBe(3);
  });
  it('keeps exclusion-only and empty scopes at zero without querying', async () => {
    const query = jest.fn();
    expect(await countScopeRules({ query } as never, 'workspace', [])).toEqual(
      [],
    );
    expect(
      await countScopeRules({ query } as never, 'workspace', [
        excluded(owned),
        excluded(owned),
      ]),
    ).toEqual([0, 0]);
    expect(query).not.toHaveBeenCalled();
  });
  it('retains the single asset exclusion query path', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([{ count: 1 }]);
    expect(
      await countScopeRules({ query } as never, 'workspace', [
        include,
        excluded(owned),
      ]),
    ).toEqual([3, 1]);
    expect(query.mock.calls.length).toBe(2);
  });
  it('propagates database errors instead of returning misleading zero matches', async () => {
    const error = new Error('database unavailable'),
      query = jest.fn().mockRejectedValue(error);
    await expect(
      countScopeRules({ query } as never, 'workspace', [
        include,
        excluded(owned),
        excluded(owned),
      ]),
    ).rejects.toBe(error);
  });
});
