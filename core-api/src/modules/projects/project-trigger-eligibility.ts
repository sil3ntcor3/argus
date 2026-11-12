import { isTriggerEvent } from './project-trigger-config';

/** Caller supplies scoped job counts from the same authoritative completion snapshot. */
export interface RunCompletionEvidence {
  readonly isCompleted: boolean;
  readonly activeJobs: number;
  readonly cancelledJobs: number;
  readonly steps: unknown;
}
export interface TriggerRunCause {
  readonly chainDepth: number;
  readonly projectWorkflowId: string | null;
}
export const MAX_TRIGGER_CHAIN_DEPTH = 3;

/** Classify an authoritative completion snapshot without emitting events. */
export function runOutcomeOf(
  run: RunCompletionEvidence,
): 'success' | 'failure' | null {
  if (
    run.isCompleted !== true ||
    run.activeJobs !== 0 ||
    run.cancelledJobs !== 0
  )
    return null;
  if (!run.steps || typeof run.steps !== 'object' || Array.isArray(run.steps))
    return null;
  const states = Object.values(run.steps as Record<string, unknown>);
  if (states.length === 0) return null;
  let failed = false;
  for (const state of states) {
    if (!state || typeof state !== 'object' || Array.isArray(state))
      return null;
    const { status, reason } = state as Record<string, unknown>;
    if (reason === 'run-cancelled') return null;
    if (
      status === 'failed' ||
      (status === 'skipped' && reason === 'blocked-by-failure')
    )
      failed = true;
    else if (
      status !== 'done' &&
      !(
        status === 'skipped' &&
        (reason === 'no-inputs' || reason === 'assets-discovery-off')
      )
    )
      return null;
  }
  return failed ? 'failure' : 'success';
}

/** Return an allowed causal depth or null to suppress this trigger. */
export function triggerChainDepth(
  event: string,
  listenerId: string,
  cause: TriggerRunCause | null,
): number | null {
  if (!isTriggerEvent(event)) return null;
  if (cause === null) return 0;
  if (!Number.isSafeInteger(cause.chainDepth) || cause.chainDepth < 0)
    return null;
  const depth = cause.chainDepth + 1;
  if (depth > MAX_TRIGGER_CHAIN_DEPTH) return null;
  if (
    cause.projectWorkflowId === listenerId &&
    event !== 'project.assets.added'
  )
    return null;
  return depth;
}
