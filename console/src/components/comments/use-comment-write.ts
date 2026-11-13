import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';
import { getGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';

type RequestOptions = { signal: AbortSignal; timeout: number };
const unknownOutcome = (error: unknown) => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
};

/** Discussion writes are serialized per thread and never replayed across reconnects or workspace changes. */
export function useCommentWrite<Action>({ workspaceId, queryKey, canWrite, perform, onSuccess, onDiscard }: {
  workspaceId: string; queryKey: readonly string[]; canWrite: boolean;
  perform: (action: Action, options: RequestOptions) => Promise<unknown>;
  onSuccess: (action: Action) => void;
  onDiscard: (actions: Action[]) => void;
}) {
  const client = useQueryClient();
  const mutationKey = ['comment-write', ...queryKey];
  const filter = { mutationKey, exact: true };
  const pending = useIsMutating(filter) > 0;
  const failures = useMutationState({ filters: { ...filter, status: 'error' }, select: mutation => mutation });
  const uncertain = failures.some(mutation => unknownOutcome(mutation.state.error));
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const state = useRef({ live: true, generation: 0, locked: false, controller: new AbortController() });
  useEffect(() => {
    const scope = state.current; scope.live = true;
    const invalidate = () => { scope.generation++; scope.controller.abort(); };
    const unsubscribe = subscribeGlobalWorkspaceId(invalidate);
    return () => { scope.live = false; invalidate(); unsubscribe(); };
  }, []);
  const current = (generation: number) => state.current.live &&
    state.current.generation === generation && getGlobalWorkspaceId() === workspaceId;
  const mutation = useMutation({
    mutationKey, retry: false, networkMode: 'always', onError: () => {},
    mutationFn: ({ action, request }: { action: Action; request: RequestOptions }) => {
      if (!canWrite || getGlobalWorkspaceId() !== workspaceId || request.signal.aborted || !navigator.onLine)
        throw new Error('Discussion access changed or offline');
      return perform(action, request);
    },
  });

  /** Recheck scope at dispatch; cancel stale callbacks without clearing another thread's draft. */
  async function run(action: Action) {
    const scope = state.current;
    if (!canWrite || uncertain || scope.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setError('Reconnect before changing comments.'); return; }
    const generation = scope.generation;
    scope.locked = true; scope.controller = new AbortController(); setSaving(true); setError(undefined); setReviewed(false);
    try {
      await mutation.mutateAsync({ action, request: { signal: scope.controller.signal, timeout: 20_000 } });
      await client.invalidateQueries({ queryKey, exact: true, refetchType: current(generation) ? 'active' : 'none' });
      if (current(generation)) onSuccess(action);
    } catch (cause) {
      if (current(generation)) setError(unknownOutcome(cause)
        ? 'Outcome unknown. Check saved comments before trying again.'
        : 'Unable to change the comment. Check your access and try again.');
    } finally { scope.locked = false; if (current(generation)) setSaving(false); }
  }

  /** A partial read cannot prove an uncertain create failed; keep the submission locked. */
  async function checkSaved(reload: () => Promise<unknown>) {
    if (state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setError('Reconnect before checking saved comments.'); return; }
    const generation = state.current.generation;
    state.current.locked = true; setChecking(true);
    try {
      await reload();
      if (!current(generation)) return;
      if (uncertain) { setReviewed(true); setError(undefined); }
      else { mutation.reset(); setError(undefined); }
    } catch { if (current(generation)) setError('Unable to check saved comments. Try again when connected.'); }
    finally { state.current.locked = false; if (current(generation)) setChecking(false); }
  }

  /** Explicitly abandon the local submission, clearing its form without replaying the request. */
  function discard() {
    if (!reviewed || state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    const actions = failures.filter(failure => unknownOutcome(failure.state.error))
      .map(failure => (failure.state.variables as { action: Action }).action);
    for (const failure of failures) client.getMutationCache().remove(failure);
    mutation.reset(); setError(undefined); setReviewed(false); onDiscard(actions);
  }
  return { run, checkSaved, discard, reviewed, busy: pending || saving || checking, uncertain,
    error: error ?? (uncertain ? 'Outcome unknown. Check saved comments before trying again.' : undefined) };
}
