import {
  runOutcomeOf,
  triggerChainDepth,
  type RunCompletionEvidence,
} from './project-trigger-eligibility';

const evidence = (
  steps: unknown,
  overrides: Partial<RunCompletionEvidence> = {},
): RunCompletionEvidence => ({
  isCompleted: true,
  activeJobs: 0,
  cancelledJobs: 0,
  steps,
  ...overrides,
});
describe('Private trigger run outcomes', () => {
  it.each([
    { scan: { status: 'done' } },
    { scan: { status: 'done', jobs: 3, failed: 2 } },
    { scan: { status: 'skipped', reason: 'no-inputs' } },
    { scan: { status: 'skipped', reason: 'assets-discovery-off' } },
  ])('preserves successful graph semantics %j', (steps) => {
    expect(runOutcomeOf(evidence(steps))).toBe('success');
  });
  it.each([
    { scan: { status: 'failed' } },
    { scan: { status: 'skipped', reason: 'blocked-by-failure' } },
  ])('classifies a settled failure %j', (steps) => {
    expect(runOutcomeOf(evidence(steps))).toBe('failure');
  });
  it.each([
    { isCompleted: false },
    { activeJobs: 1 },
    { activeJobs: -1 },
    { cancelledJobs: 1 },
    { cancelledJobs: -1 },
    { cancelledJobs: NaN },
  ])(
    'suppresses missing closure or nonzero/invalid job evidence %j',
    (overrides) => {
      expect(
        runOutcomeOf(evidence({ scan: { status: 'done' } }, overrides)),
      ).toBeNull();
    },
  );
  it('requires numeric authoritative counts, including for an all-done cancelled graph', () => {
    const steps = { scan: { status: 'done' } };
    expect(runOutcomeOf(evidence(steps, { cancelledJobs: 4 }))).toBeNull();
    for (const overrides of [
      { activeJobs: undefined },
      { cancelledJobs: undefined },
      { activeJobs: '0' },
    ]) {
      expect(
        runOutcomeOf({
          ...evidence(steps),
          ...overrides,
        } as unknown as RunCompletionEvidence),
      ).toBeNull();
    }
  });
  it.each([
    null,
    undefined,
    {},
    [],
    42,
    'legacy',
    { scan: null },
    { scan: [] },
    { scan: { status: 'pending' } },
    { scan: { status: 'dispatched' } },
    { scan: { status: 'unknown' } },
    { scan: { status: 'skipped' } },
    { scan: { status: 'skipped', reason: 'unknown' } },
  ])('suppresses incomplete or unknown step data %j', (steps) => {
    expect(runOutcomeOf(evidence(steps))).toBeNull();
  });
  it.each([false, true])(
    'gives cancellation priority regardless of failure order %s',
    (reverse) => {
      const entries = [
        ['failed', { status: 'failed' }],
        ['cancelled', { status: 'skipped', reason: 'run-cancelled' }],
      ];
      if (reverse) entries.reverse();
      expect(runOutcomeOf(evidence(Object.fromEntries(entries)))).toBeNull();
    },
  );
  it('does not mutate the closed-run snapshot', () => {
    const steps = Object.freeze({ scan: Object.freeze({ status: 'done' }) });
    const input = Object.freeze(evidence(steps));
    expect(runOutcomeOf(input)).toBe('success');
    expect(input.steps).toBe(steps);
  });
});

describe('Private trigger chain eligibility', () => {
  const cause = Object.freeze({ chainDepth: 0, projectWorkflowId: 'origin' });
  it.each([
    'project.assets.added',
    'project.run.completed',
    'vulnerability.detected',
  ])('starts root depth zero for %s', (event) => {
    expect(triggerChainDepth(event, 'listener', null)).toBe(0);
    expect(triggerChainDepth(event, 'listener', cause)).toBe(1);
    expect(cause.chainDepth).toBe(0);
  });
  it('allows the third causal hop and rejects the fourth', () => {
    expect(
      triggerChainDepth('project.assets.added', 'listener', {
        ...cause,
        chainDepth: 2,
      }),
    ).toBe(3);
    expect(
      triggerChainDepth('project.assets.added', 'listener', {
        ...cause,
        chainDepth: 3,
      }),
    ).toBeNull();
    expect(
      triggerChainDepth('project.assets.added', 'listener', {
        ...cause,
        projectWorkflowId: null,
      }),
    ).toBe(1);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects unusable or excessive depth %s',
    (chainDepth) => {
      expect(
        triggerChainDepth('project.assets.added', 'listener', {
          ...cause,
          chainDepth,
        }),
      ).toBeNull();
    },
  );
  it.each(['project.run.completed', 'vulnerability.detected'])(
    'blocks direct self-triggering for %s',
    (event) => {
      expect(triggerChainDepth(event, 'origin', cause)).toBeNull();
      expect(triggerChainDepth('project.assets.added', 'origin', cause)).toBe(
        1,
      );
    },
  );
  it('rejects unrecognized event names before admitting a root cause', () => {
    expect(triggerChainDepth('constructor', 'listener', null)).toBeNull();
    expect(triggerChainDepth('unknown', 'listener', cause)).toBeNull();
  });
});
