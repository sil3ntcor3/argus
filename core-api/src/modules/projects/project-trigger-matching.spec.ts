import { Severity } from '@/common/enums/enum';
import { chunk, matchTriggers } from './project-trigger-matching';

const row = (
  overrides: Partial<{
    id: string;
    type: string;
    enabled: boolean;
    event: string | null;
    projectWorkflowId: string;
    config: unknown;
  }> = {},
) => ({
  id: 'trigger',
  type: 'event',
  enabled: true,
  event: 'project.assets.added',
  projectWorkflowId: 'binding-listener',
  config: {} as unknown,
  ...overrides,
});
const completed = {
  event: 'project.run.completed' as const,
  projectWorkflowId: 'binding-source',
  workflowName: ' Recon ',
  outcome: 'success' as const,
};
describe('Private trigger batch splitting', () => {
  it('preserves order and duplicates, with independent chunk arrays', () => {
    const items = Object.freeze(['a', 'a', 'b', 'c', 'd']);
    const result = chunk(items, 2);
    expect(result).toEqual([['a', 'a'], ['b', 'c'], ['d']]);
    result[0].push('new');
    expect(items).toEqual(['a', 'a', 'b', 'c', 'd']);
    expect(result[1]).toEqual(['b', 'c']);
    expect(chunk(items, Number.MAX_SAFE_INTEGER)).toEqual([items]);
    expect(chunk([], 1)).toEqual([]);
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid batch size %s even for empty input',
    (size) => {
      expect(() => chunk(['asset'], size)).toThrow(RangeError);
      expect(() => chunk([], size)).toThrow(RangeError);
    },
  );
});

describe('Private project trigger matching', () => {
  it('follows other workflows by normalized name and successful outcome by default', () => {
    const any = row({ event: completed.event });
    const recon = row({
      event: completed.event,
      config: { workflows: ['reCON'] },
    });
    const other = row({
      event: completed.event,
      config: { workflows: ['Crawl'] },
    });
    const failure = row({
      event: completed.event,
      config: { status: ['failure'] },
    });
    const own = row({
      event: completed.event,
      projectWorkflowId: completed.projectWorkflowId,
    });
    expect(
      matchTriggers(completed, [any, recon, other, failure, own], ['a']).map(
        (m) => m.trigger,
      ),
    ).toEqual([any, recon]);
    expect(
      matchTriggers(
        { ...completed, outcome: 'failure' },
        [any, failure],
        ['a'],
      ).map((m) => m.trigger),
    ).toEqual([failure]);
  });
  it.each([
    Severity.CRITICAL,
    Severity.HIGH,
    Severity.MEDIUM,
    Severity.LOW,
    Severity.INFO,
  ])('matches configured finding severity %s', (severity) => {
    const standard = row({ event: 'vulnerability.detected' });
    const low = row({
      event: 'vulnerability.detected',
      config: { severity: [Severity.LOW] },
    });
    const result = matchTriggers(
      { event: 'vulnerability.detected', severities: [severity] },
      [standard, low],
      ['asset'],
    );
    expect(result.map((m) => m.trigger)).toEqual(
      severity === Severity.CRITICAL || severity === Severity.HIGH
        ? [standard]
        : severity === Severity.LOW
          ? [low]
          : [],
    );
    expect(
      matchTriggers(
        { event: 'vulnerability.detected', severities: [] },
        [standard],
        ['asset'],
      ),
    ).toEqual([]);
  });
  it.each([
    { enabled: false },
    { enabled: undefined },
    { type: 'cron' },
    { event: null },
    { event: 'unknown' },
    { event: 'constructor' },
    { event: 'project.run.completed' },
  ])('skips disabled, malformed or unrelated row %j', (overrides) => {
    expect(
      matchTriggers({ event: 'project.assets.added' }, [row(overrides)], ['a']),
    ).toEqual([]);
  });
  it.each([
    null,
    [],
    { workflows: true },
    { status: 'success' },
    { status: [] },
    { windowMinutes: 1.5 },
    { maxAssets: 0 },
    { targetTypes: ['unknown'] },
  ])('skips malformed known configuration %j without throwing', (config) => {
    expect(
      matchTriggers(
        completed,
        [row({ event: completed.event, config })],
        ['a'],
      ),
    ).toEqual([]);
  });
  it('ignores opaque stored fields while preserving known matching semantics', () => {
    const trigger = row({
      event: completed.event,
      config: { workflows: [' recon '], legacy: 'opaque' },
    });
    expect(
      matchTriggers(completed, [trigger], ['a']).map((m) => m.trigger),
    ).toEqual([trigger]);
  });
  it('returns independent asset arrays, preserves row identity and never mutates inputs', () => {
    const first = Object.freeze(
      row({ id: 'first', config: Object.freeze({}) }),
    );
    const second = Object.freeze(row({ id: 'second' }));
    const ids = Object.freeze(['a', 'a', 'b']);
    const fact = Object.freeze({ event: 'project.assets.added' as const });
    const result = matchTriggers(fact, Object.freeze([first, second]), ids);
    expect(result.map((m) => m.assetIds)).toEqual([ids, ids]);
    expect(result[0].trigger).toBe(first);
    result[0].assetIds.push('new');
    expect(result[1].assetIds).toEqual(ids);
    expect(ids).toEqual(['a', 'a', 'b']);
    expect(matchTriggers(fact, [first], [])).toEqual([]);
    expect(matchTriggers(fact, [], ids)).toEqual([]);
  });
});
