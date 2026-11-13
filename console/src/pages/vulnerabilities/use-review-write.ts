import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';
import { getGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';

type RequestOptions = { signal: AbortSignal; timeout: number };
const unknownOutcome = (error: unknown, partial = false) => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return partial || status === undefined || status === 408 || status >= 500;
};

/** Serialize review decisions across dialogs; a bulk failure can have partial commits. */
export function useReviewWrite<Input, Output>({ workspaceId, canWrite, perform, onSuccess, onDiscard, onPersisted, partial = false }: {
  workspaceId: string; canWrite: boolean;
  perform: (input: Input, options: RequestOptions) => Promise<Output>;
  onSuccess: (result: Output) => void; onDiscard: () => void;
  onPersisted?: (result: Output) => void | Promise<void>;
  partial?: boolean;
}) {
  const client = useQueryClient();
  const mutationKey = ['finding-review-write', workspaceId];
  const filter = { mutationKey, exact: true };
  const pending = useIsMutating(filter) > 0;
  const failures = useMutationState({ filters: { ...filter, status: 'error' }, select: mutation => mutation });
  const uncertain = failures.some(mutation => unknownOutcome(mutation.state.error, (mutation.state.variables as { partial?: boolean } | undefined)?.partial));
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
  const current = (generation: number) => state.current.live && state.current.generation === generation && getGlobalWorkspaceId() === workspaceId;
  const mutation = useMutation({
    mutationKey, retry: false, networkMode: 'always', onError: () => {},
    mutationFn: ({ input, request }: { input: Input; request: RequestOptions; partial: boolean }) => {
      if (!canWrite || getGlobalWorkspaceId() !== workspaceId || request.signal.aborted || !navigator.onLine)
        throw new Error('Review access changed or offline');
      return perform(input, request);
    },
  });
  async function run(input: Input) {
    const scope = state.current;
    if (!canWrite || uncertain || scope.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setError('Reconnect before reviewing findings.'); return; }
    const generation = scope.generation;
    let committed = false;
    scope.locked = true; scope.controller = new AbortController(); setSaving(true); setError(undefined); setReviewed(false);
    try {
      const result = await mutation.mutateAsync({ input, partial, request: { signal: scope.controller.signal, timeout: 20_000 } });
      committed = true;
      // A merge removes the current detail resource; navigate to its known
      // target before invalidation can unmount the original resource's dialog.
      if (current(generation)) await onPersisted?.(result);
      await client.invalidateQueries({ predicate: ({ queryKey: [path] }) => typeof path === 'string' &&
        (path === 'vulnerabilities' || /^\/api\/(vulnerabilities|targets|projects|statistic)(\/|$)/i.test(path)),
        refetchType: current(generation) ? 'active' : 'none' });
      if (current(generation)) onSuccess(result);
    } catch (cause) {
      if (current(generation)) setError(committed ? 'Review saved. Refresh the findings to view the result.' : unknownOutcome(cause, partial)
        ? 'Outcome unknown. Some decisions may have saved. Check saved state before reviewing again.'
        : 'Unable to review. Refresh the findings and check your access or selection.');
    } finally { scope.locked = false; if (current(generation)) setSaving(false); }
  }
  /** Refreshing a page cannot prove every decision in a bulk request failed. */
  async function checkSaved(reload: () => Promise<unknown>) {
    if (state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setError('Reconnect before checking saved state.'); return; }
    const generation = state.current.generation;
    state.current.locked = true; setChecking(true);
    try {
      await reload();
      if (current(generation)) { setReviewed(true); setError(undefined); }
    } catch { if (current(generation)) setError('Unable to check saved state. Try again when connected.'); }
    finally { state.current.locked = false; if (current(generation)) setChecking(false); }
  }
  /** Explicitly clear the local selection and draft; this never repeats a request. */
  function discard() {
    if (!reviewed || state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    for (const failure of failures) client.getMutationCache().remove(failure);
    mutation.reset(); setError(undefined); setReviewed(false); onDiscard();
  }
  return { run, checkSaved, discard, reviewed, busy: pending || saving || checking, uncertain,
    error: error ?? (uncertain ? 'Outcome unknown. Some decisions may have saved. Check saved state before reviewing again.' : undefined) };
}
