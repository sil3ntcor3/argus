import { TargetType } from '@/common/enums/enum';
import { WorkflowOnError, onOfTriggers } from './project-workflow-on';
import {
  enabledByKey,
  triggersOfInput,
  type WorkflowOnInput,
} from './project-workflow-on-input';

const event = 'project.assets.added';
const parse = (input: unknown) => triggersOfInput(input as WorkflowOnInput);
const states = (input: unknown) => [...enabledByKey(input as WorkflowOnInput)];
describe('Private project workflow editor input', () => {
  it('converts editor input to canonical definitions without persisting runtime state', () => {
    const input: WorkflowOnInput = {
      schedule: [{ cron: ' 0  6 * * * ', enabled: false }],
      events: [
        {
          event,
          windowMinutes: 0,
          targetTypes: [TargetType.IP],
          enabled: false,
        },
      ],
    };
    expect(onOfTriggers(triggersOfInput(input))).toEqual({
      schedule: [{ cron: '0 6 * * *' }],
      [event]: {
        windowMinutes: 0,
        maxAssets: 200,
        targetTypes: [TargetType.IP],
      },
    });
    expect(JSON.stringify(triggersOfInput(input))).not.toContain('enabled');
  });
  it('extracts only explicit state choices under canonical keys', () => {
    expect(
      states({
        schedule: [
          { cron: '0  6 * * *', enabled: false },
          { cron: '15 7 * * *', enabled: true },
        ],
        events: [
          { event, enabled: false },
          { event: 'project.run.completed', enabled: true },
        ],
      }),
    ).toEqual([
      ['cron:0 6 * * *', false],
      ['cron:15 7 * * *', true],
      ['event:project.assets.added', false],
      ['event:project.run.completed', true],
    ]);
  });
  it('does not choose activation when state is omitted', () => {
    expect(states({})).toEqual([]);
    expect(
      states({ schedule: [{ cron: '0 6 * * *' }], events: [{ event }] }),
    ).toEqual([]);
  });
  it('collapses duplicate definitions and explicit flags to their first entries', () => {
    const input: WorkflowOnInput = {
      schedule: [
        { cron: '0  6 * * *', enabled: false },
        { cron: '0 6 * * *', enabled: true },
      ],
      events: [
        { event, windowMinutes: 0, enabled: false },
        { event, windowMinutes: 20, enabled: true },
      ],
    };
    expect(triggersOfInput(input)).toHaveLength(2);
    expect(triggersOfInput(input)[1]).toMatchObject({
      config: { windowMinutes: 0 },
    });
    expect(states(input)).toEqual([
      ['cron:0 6 * * *', false],
      ['event:project.assets.added', false],
    ]);
  });
  it('keeps the first omitted state instead of applying a later duplicate activation', () => {
    expect(
      states({
        schedule: [
          { cron: '0 6 * * *' },
          { cron: '0  6 * * *', enabled: true },
        ],
        events: [{ event }, { event, enabled: true }],
      }),
    ).toEqual([]);
  });
  it.each(
    [
      undefined,
      null,
      [],
      true,
      { unexpected: true },
      { schedule: 'cron' },
      { events: {} },
      { schedule: [null] },
      { events: [42] },
    ].map((value) => [value]),
  )('rejects malformed input: %j', (input) => {
    expect(() => parse(input)).toThrow(WorkflowOnError);
    expect(() => states(input)).toThrow(WorkflowOnError);
  });
  it.each([
    { schedule: [{ cron: 'disabled' }] },
    { schedule: [{ cron: '0 0 31 2 *' }] },
    { events: [{ event: 'unknown' }] },
    { events: [{ event, status: ['success'] }] },
    { events: [{ event, secret: 'hidden' }] },
    { schedule: [{ cron: '0 6 * * *', timezone: 'UTC' }] },
  ])('rejects invalid definitions and unsupported fields: %j', (input) => {
    expect(() => parse(input)).toThrow(WorkflowOnError);
    expect(() => states(input)).toThrow(WorkflowOnError);
  });
  it.each(['false', 0, null, {}])(
    'rejects non-boolean state metadata: %j',
    (enabled) => {
      for (const input of [
        { schedule: [{ cron: '0 6 * * *', enabled }] },
        { events: [{ event, enabled }] },
      ]) {
        expect(() => parse(input)).toThrow(WorkflowOnError);
        expect(() => states(input)).toThrow(WorkflowOnError);
      }
    },
  );
  it('does not mutate source objects or share returned event arrays', () => {
    const targetTypes = [TargetType.DOMAIN];
    Object.freeze(targetTypes);
    const input: WorkflowOnInput = {
      schedule: Object.freeze([
        Object.freeze({ cron: '0  6 * * *', enabled: false }),
      ]),
      events: Object.freeze([
        Object.freeze({ event, targetTypes, enabled: false }),
      ]),
    };
    Object.freeze(input);
    const before = JSON.stringify(input),
      parsed = triggersOfInput(input);
    const definition = parsed[1];
    if (definition.type === 'event')
      definition.config.targetTypes?.push(TargetType.IP);
    enabledByKey(input).set('other', true);
    expect(JSON.stringify(input)).toBe(before);
    expect(triggersOfInput(input)[1]).toMatchObject({
      config: { targetTypes: [TargetType.DOMAIN] },
    });
  });
  it('rejects prototype-like event names and configuration keys', () => {
    for (const name of ['__proto__', 'constructor', 'toString'])
      expect(() => parse({ events: [{ event: name }] })).toThrow(
        WorkflowOnError,
      );
    const input: unknown = JSON.parse(
      '{"events":[{"event":"project.assets.added","__proto__":{"windowMinutes":0}}]}',
    );
    expect(() => parse(input)).toThrow(WorkflowOnError);
  });
});
