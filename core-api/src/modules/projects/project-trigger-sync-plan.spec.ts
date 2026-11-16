import { TargetType } from '@/common/enums/enum';
import { normalizeEventConfig } from './project-trigger-config';
import { triggersOfOn } from './project-workflow-on';
import { keyOfRow, planTriggerSync } from './project-trigger-sync-plan';

const event = 'project.assets.added';
const row = (
  id: string,
  config: unknown = normalizeEventConfig(event),
  enabled = true,
) => ({
  id,
  type: 'event',
  event,
  cron: null as string | null,
  config,
  enabled,
  schedulerId: 'saved-' + id,
  lastFiredAt: new Date('2026-11-11T00:00:00Z'),
});
describe('Private project trigger synchronization plan', () => {
  it('returns no operations for empty input', () => {
    expect(planTriggerSync([], [])).toEqual({
      create: [],
      update: [],
      remove: [],
    });
  });
  it('keys valid stored cron/event rows and rejects invalid identities', () => {
    expect(keyOfRow(row('event'))).toBe('event:project.assets.added');
    expect(
      keyOfRow({
        ...row('cron'),
        type: 'cron',
        cron: ' 0  6 * * * ',
        event: null,
      }),
    ).toBe('cron:0 6 * * *');
    for (const invalid of [
      { ...row('a'), type: 'unknown' },
      { ...row('b'), event: null },
      { ...row('c'), event: 'unknown' },
      { ...row('d'), type: 'cron', cron: null },
      { ...row('e'), type: 'cron', cron: ' ' },
    ])
      expect(keyOfRow(invalid)).toBeUndefined();
  });
  it('creates missing definitions with independent arrays and leaves activation to the caller', () => {
    const defined = triggersOfOn({ schedule: '0 6 * * *', [event]: true });
    const plan = planTriggerSync([], defined);
    expect(plan).toEqual({ create: defined, update: [], remove: [] });
    expect(plan.create[0]).not.toBe(defined[0]);
    expect(plan.create[1]).not.toHaveProperty('enabled');
    const created = plan.create[1];
    if (created.type === 'event')
      created.config.targetTypes?.push(TargetType.IP);
    expect(defined[1]).toMatchObject({ config: { targetTypes: [] } });
  });
  it('reuses canonical identities, defaults and semantically equal JSON field orders', () => {
    const stored = [
      { ...row('cron'), type: 'cron', cron: '0  6 * * *', event: null },
      row('default', {}),
    ];
    stored[1].config = {
      targetTypes: [],
      maxAssets: 200,
      windowMinutes: 10,
      privateNote: 'retain',
    };
    const before = JSON.stringify(stored);
    expect(
      planTriggerSync(
        stored,
        triggersOfOn({ schedule: '0 6 * * *', [event]: true }),
      ),
    ).toEqual({ create: [], update: [], remove: [] });
    expect(JSON.stringify(stored)).toBe(before);
    expect(
      planTriggerSync([row('compact', {})], triggersOfOn({ [event]: true }))
        .update,
    ).toEqual([]);
  });
  it('updates changed event settings without replacing identity or runtime state', () => {
    const stored = Object.freeze(row('kept', {}, false));
    const defined = triggersOfOn({ [event]: { windowMinutes: 0 } });
    const plan = planTriggerSync([stored], defined);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update[0].row).toBe(stored);
    expect(plan.update[0].row).toMatchObject({
      id: 'kept',
      enabled: false,
      schedulerId: 'saved-kept',
      lastFiredAt: new Date('2026-11-11T00:00:00Z'),
    });
    expect(plan.update[0].config).toEqual({
      ...normalizeEventConfig(event),
      windowMinutes: 0,
    });
    plan.update[0].config.targetTypes?.push(TargetType.IP);
    expect(defined[0]).toMatchObject({ config: { targetTypes: [] } });
    expect(stored.config).toEqual({});
  });
  it('removes definitions absent from the file and invalid stored identities', () => {
    const removed = row('gone'),
      invalid = { ...row('invalid'), type: 'unknown' };
    expect(planTriggerSync([removed, invalid], [])).toEqual({
      create: [],
      update: [],
      remove: [removed, invalid],
    });
    const result = planTriggerSync([invalid], triggersOfOn({ [event]: true }));
    expect(result.create).toHaveLength(1);
    expect(result.remove).toEqual([invalid]);
  });
  it('keeps a disabled duplicate regardless of input order', () => {
    const off = row('off', {}, false),
      on = row('on');
    for (const rows of [
      [off, on],
      [on, off],
    ]) {
      expect(planTriggerSync(rows, triggersOfOn({ [event]: true }))).toEqual({
        create: [],
        update: [],
        remove: [on],
      });
      expect(off.enabled).toBe(false);
    }
  });
  it('keeps the last row when duplicate runtime flags agree', () => {
    const first = row('first'),
      last = row('last');
    expect(
      planTriggerSync([first, last], triggersOfOn({ [event]: true })).remove,
    ).toEqual([first]);
  });
  it.each(
    [
      null,
      [],
      42,
      { targetTypes: 3 },
      { windowMinutes: '10' },
      { maxAssets: 0 },
    ].map((value) => [value]),
  )(
    'plans repair of malformed stored settings without throwing: %j',
    (config) => {
      const stored = row('repair', config, false);
      const result = planTriggerSync([stored], triggersOfOn({ [event]: true }));
      expect(result.create).toEqual([]);
      expect(result.remove).toEqual([]);
      expect(result.update).toEqual([
        { row: stored, config: normalizeEventConfig(event) },
      ]);
      expect(stored.config).toBe(config);
      expect(stored.enabled).toBe(false);
    },
  );
});
