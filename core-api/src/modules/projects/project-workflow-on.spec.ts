import { TargetType } from '@/common/enums/enum';
import {
  cronKey,
  eventKey,
  normalizeCron,
  onOfTriggers,
  triggersOfOn,
  WorkflowOnError,
} from './project-workflow-on';

const event = 'project.assets.added';
const common = { windowMinutes: 10, maxAssets: 200, targetTypes: [] };
describe('Private project workflow on definitions', () => {
  it.each(
    [
      undefined,
      null,
      false,
      0,
      'legacy',
      [],
      { target: { created: true } },
    ].map((value) => [value]),
  )('has no project triggers for %j', (on) => {
    expect(triggersOfOn(on)).toEqual([]);
  });
  it('uses stable keys and normalized cron whitespace', () => {
    expect(normalizeCron(' \t0  6 *  * *\n')).toBe('0 6 * * *');
    expect(cronKey('0  6 * * *')).toBe('cron:0 6 * * *');
    expect(eventKey(event)).toBe('event:project.assets.added');
  });
  it.each(
    [' 0  6 * * * ', ['0 6 * * *'], [{ cron: '0 6 * * *' }]].map((value) => [
      value,
    ]),
  )('reads schedule representations: %j', (schedule) => {
    expect(triggersOfOn({ schedule })).toEqual([
      { key: 'cron:0 6 * * *', type: 'cron', cron: '0 6 * * *' },
    ]);
  });
  it('deduplicates canonical crons without reordering or mutating schedules', () => {
    const schedule = Object.freeze([
      '0  6 * * *',
      Object.freeze({ cron: '15 7 * * *' }),
      '0 6 * * *',
    ]);
    expect(triggersOfOn({ schedule })).toEqual([
      { key: 'cron:0 6 * * *', type: 'cron', cron: '0 6 * * *' },
      { key: 'cron:15 7 * * *', type: 'cron', cron: '15 7 * * *' },
    ]);
    expect(schedule[0]).toBe('0  6 * * *');
  });
  it('emits recognized events in stable order with their validated defaults and filters', () => {
    const on = {
      'vulnerability.detected': { severity: ['low'] },
      'project.run.completed': { workflows: ['Recon'], status: ['failure'] },
      'project.assets.added': true,
    };
    expect(triggersOfOn(on)).toEqual([
      { key: eventKey(event), type: 'event', event, config: common },
      {
        key: 'event:project.run.completed',
        type: 'event',
        event: 'project.run.completed',
        config: { ...common, workflows: ['Recon'], status: ['failure'] },
      },
      {
        key: 'event:vulnerability.detected',
        type: 'event',
        event: 'vulnerability.detected',
        config: { ...common, severity: ['low'] },
      },
    ]);
    expect(
      triggersOfOn({
        'project.run.completed': false,
        'vulnerability.detected': false,
      }),
    ).toEqual([]);
  });
  it.each([
    null,
    42,
    {},
    'disabled',
    '0 0 31 2 *',
    '60 * * * *',
    '0 * * * * *',
  ])('rejects an invalid cron entry: %j', (schedule) => {
    expect(() => triggersOfOn({ schedule: [schedule] })).toThrow(
      WorkflowOnError,
    );
    expect(() => triggersOfOn({ schedule: [schedule] })).toThrow(
      'on.schedule[0]',
    );
  });
  it.each(
    [
      null,
      [],
      42,
      'settings',
      { windowMinutes: -1 },
      { status: ['success'] },
    ].map((value) => [value]),
  )('rejects invalid event configuration: %j', (config) => {
    expect(() => triggersOfOn({ [event]: config })).toThrow(WorkflowOnError);
    expect(() => triggersOfOn({ [event]: config })).toThrow(
      'on.project.assets.added',
    );
  });
  it('preserves structured validation errors', () => {
    expect(new WorkflowOnError(['first', 'second'])).toMatchObject({
      errors: ['first', 'second'],
      message: 'first; second',
    });
  });
  it('reports all invalid entries instead of returning a partial runnable definition', () => {
    const on = {
      schedule: ['invalid', '0 6 * * *'],
      [event]: { maxAssets: 0 },
      unknown: true,
    };
    expect(() => triggersOfOn(on)).toThrow('on.schedule[0]');
    expect(() => triggersOfOn(on)).toThrow('on.project.assets.added');
    expect(() => triggersOfOn(on)).toThrow('on.unknown');
  });
  it('serializes canonical schedules and explicit event defaults and round-trips definitions', () => {
    const parsed = triggersOfOn({
      target: { created: true },
      schedule: '0 6 * * *',
      [event]: true,
    });
    expect(onOfTriggers(parsed)).toEqual({
      schedule: [{ cron: '0 6 * * *' }],
      [event]: common,
    });
    expect(triggersOfOn(onOfTriggers(parsed))).toEqual(parsed);
    expect(onOfTriggers([])).toBeUndefined();
  });
  it('keeps legacy target settings and returned arrays independent of source definitions', () => {
    const target = Object.freeze({ created: true }),
      targetTypes = [TargetType.DOMAIN];
    const on = Object.freeze({
      target,
      [event]: Object.freeze({
        targetTypes: Object.freeze(targetTypes),
        windowMinutes: 0,
      }),
    });
    const parsed = triggersOfOn(on);
    const serialized = onOfTriggers(parsed)!;
    serialized[event]?.targetTypes?.push(TargetType.IP);
    expect(on.target).toBe(target);
    expect(on[event].targetTypes).toEqual([TargetType.DOMAIN]);
    expect(parsed[0]).toMatchObject({
      config: { windowMinutes: 0, targetTypes: [TargetType.DOMAIN] },
    });
    expect(onOfTriggers(parsed)?.[event]?.targetTypes).toEqual([
      TargetType.DOMAIN,
    ]);
  });
});
