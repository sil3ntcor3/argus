import { Severity, TargetType } from '@/common/enums/enum';
import type { ProjectTriggerConfigDto } from './dto/project-trigger-read.dto';
import {
  eventConfigProblems,
  isTriggerEvent,
  normalizeEventConfig,
} from './project-trigger-config';

const assets = 'project.assets.added',
  runs = 'project.run.completed',
  findings = 'vulnerability.detected';
const common = { windowMinutes: 10, maxAssets: 200, targetTypes: [] };
describe('Private project event configuration', () => {
  it('recognizes only the supported event names', () => {
    for (const value of [assets, runs, findings])
      expect(isTriggerEvent(value)).toBe(true);
    for (const value of [
      null,
      undefined,
      true,
      0,
      {},
      [],
      'unknown',
      ' project.assets.added',
    ])
      expect(isTriggerEvent(value)).toBe(false);
  });
  it('applies per-event defaults without adding irrelevant filters', () => {
    expect(normalizeEventConfig(assets)).toEqual(common);
    expect(normalizeEventConfig(runs)).toEqual({
      ...common,
      workflows: [],
      status: ['success'],
    });
    expect(normalizeEventConfig(findings)).toEqual({
      ...common,
      severity: ['critical', 'high'],
    });
  });
  it('preserves zero-delay and custom boundaries, retaining only the event settings', () => {
    const config: ProjectTriggerConfigDto = {
      windowMinutes: 0,
      maxAssets: 5000,
      targetTypes: [TargetType.IP],
      workflows: [' Recon '],
      status: ['failure'],
      severity: [Severity.LOW],
    };
    expect(normalizeEventConfig(assets, config)).toEqual({
      windowMinutes: 0,
      maxAssets: 5000,
      targetTypes: [TargetType.IP],
    });
    expect(normalizeEventConfig(runs, config)).toEqual({
      windowMinutes: 0,
      maxAssets: 5000,
      targetTypes: [TargetType.IP],
      workflows: [' Recon '],
      status: ['failure'],
    });
    expect(normalizeEventConfig(findings, config)).toEqual({
      windowMinutes: 0,
      maxAssets: 5000,
      targetTypes: [TargetType.IP],
      severity: [Severity.LOW],
    });
  });
  it('never shares mutable default or supplied arrays across normalizations', () => {
    const config: ProjectTriggerConfigDto = {
      targetTypes: [TargetType.DOMAIN],
      workflows: ['Recon'],
      status: ['success'],
      severity: [Severity.HIGH],
    };
    Object.values(config).forEach((value) => {
      if (Array.isArray(value)) Object.freeze(value);
    });
    Object.freeze(config);
    const first = normalizeEventConfig(runs, config);
    first.targetTypes?.push(TargetType.IP);
    first.workflows?.push('Other');
    first.status?.push('failure');
    const detection = normalizeEventConfig(findings, config);
    detection.severity?.push(Severity.LOW);
    expect(config).toEqual({
      targetTypes: [TargetType.DOMAIN],
      workflows: ['Recon'],
      status: ['success'],
      severity: [Severity.HIGH],
    });
    const defaults = normalizeEventConfig(runs);
    defaults.status?.push('failure');
    const severities = normalizeEventConfig(findings);
    severities.severity?.push(Severity.INFO);
    expect(normalizeEventConfig(runs).status).toEqual(['success']);
    expect(normalizeEventConfig(findings).severity).toEqual([
      'critical',
      'high',
    ]);
  });
  it.each([null, undefined, [], true, 'settings', 42])(
    'rejects non-mapping settings: %j',
    (raw) => {
      expect(eventConfigProblems(assets, raw)).toEqual([
        expect.stringContaining('must be a mapping'),
      ]);
    },
  );
  it.each([
    ['windowMinutes', -1],
    ['windowMinutes', 1441],
    ['windowMinutes', 0.5],
    ['windowMinutes', '5'],
    ['windowMinutes', null],
    ['maxAssets', 0],
    ['maxAssets', 5001],
    ['maxAssets', NaN],
    ['maxAssets', Infinity],
  ])('rejects invalid numeric setting %s=%j', (key, value) => {
    expect(eventConfigProblems(assets, { [key]: value })).toEqual([
      expect.stringContaining(String(key)),
    ]);
  });
  it.each([
    [assets, { targetTypes: ['unknown'] }],
    [assets, { targetTypes: 'DOMAIN' }],
    [runs, { workflows: 'Recon' }],
    [runs, { workflows: [' '] }],
    [runs, { workflows: [3] }],
    [runs, { workflows: Array(21).fill('Recon') }],
    [runs, { status: [] }],
    [runs, { status: ['unknown'] }],
    [runs, { status: 'success' }],
    [findings, { severity: [] }],
    [findings, { severity: ['unknown'] }],
    [findings, { severity: 'high' }],
  ] as const)('rejects invalid filter settings for %s: %j', (event, raw) => {
    expect(eventConfigProblems(event, raw)).not.toEqual([]);
  });
  it('accepts inclusive numeric bounds, empty unrestricted filters and recognized lists', () => {
    for (const event of [assets, runs, findings] as const) {
      expect(eventConfigProblems(event, {})).toEqual([]);
      expect(
        eventConfigProblems(event, {
          windowMinutes: 0,
          maxAssets: 1,
          targetTypes: [],
        }),
      ).toEqual([]);
      expect(
        eventConfigProblems(event, {
          windowMinutes: 1440,
          maxAssets: 5000,
          targetTypes: Object.values(TargetType),
        }),
      ).toEqual([]);
    }
    expect(
      eventConfigProblems(runs, {
        workflows: [],
        status: ['success', 'failure'],
      }),
    ).toEqual([]);
    expect(
      eventConfigProblems(runs, { workflows: Array(20).fill('Recon') }),
    ).toEqual([]);
    expect(
      eventConfigProblems(findings, { severity: Object.values(Severity) }),
    ).toEqual([]);
  });
  it('rejects unknown and cross-event settings together with invalid common fields', () => {
    expect(
      eventConfigProblems(assets, {
        windowMinutes: -1,
        maxAssets: 0,
        status: ['success'],
        secret: 'hidden',
      }),
    ).toEqual([
      expect.stringContaining('windowMinutes'),
      expect.stringContaining('maxAssets'),
      expect.stringContaining('unknown setting status, secret'),
    ]);
    expect(eventConfigProblems(runs, { severity: ['high'] })).toEqual([
      expect.stringContaining('unknown setting severity'),
    ]);
    expect(eventConfigProblems(findings, { workflows: ['Recon'] })).toEqual([
      expect.stringContaining('unknown setting workflows'),
    ]);
  });
  it('can ignore opaque stored keys while retaining strict validation for known fields', () => {
    expect(
      eventConfigProblems(
        assets,
        { privateNote: 'retain' },
        { ignoreUnknown: true },
      ),
    ).toEqual([]);
    expect(
      eventConfigProblems(
        assets,
        { maxAssets: 0, privateNote: 'retain' },
        { ignoreUnknown: true },
      ),
    ).toEqual([expect.stringContaining('maxAssets')]);
    expect(eventConfigProblems(assets, { privateNote: 'retain' })).toEqual([
      expect.stringContaining('unknown setting'),
    ]);
  });
});
