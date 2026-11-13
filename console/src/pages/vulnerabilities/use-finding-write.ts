import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';
import { getGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';

type Request = { signal: AbortSignal; timeout: number };
const unknownOutcome = (error: unknown) => {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status === undefined || status === 408 || status >= 500;
};

/** Writes are never queued, replayed, or acknowledged in a later workspace. */
export function useFindingWrite<Input, Output>({ workspaceId, operation, canWrite, perform, onSuccess }: {
  workspaceId: string;
  operation: string;
  canWrite: boolean;
  perform: (input: Input, request: Request) => Promise<Output>;
  onSuccess?: (result: Output) => void;
}) {
  const client = useQueryClient();
  const mutationKey = ['finding-write', workspaceId, operation];
  const filter = { mutationKey, exact: true };
  const pending = useIsMutating(filter) > 0;
  const failures = useMutationState({ filters: { ...filter, status: 'error' }, select: mutation => mutation });
  const uncertain = failures.some(mutation => unknownOutcome(mutation.state.error));
  const [message, setMessage] = useState<string>();
  const [checking, setChecking] = useState(false);
  const state = useRef({ live: true, generation: 0, locked: false, controller: new AbortController() });
  useEffect(() => {
    const current = state.current; current.live = true;
    const invalidate = () => { current.generation++; current.controller.abort(); };
    const unsubscribe = subscribeGlobalWorkspaceId(invalidate);
    return () => { current.live = false; invalidate(); unsubscribe(); };
  }, []);
  const mutation = useMutation({
    mutationKey, retry: false, networkMode: 'always',
    // Suppress the application's default toast for an aborted/stale workspace.
    // Errors are rendered below only while this write's generation is current.
    onError: () => {},
    mutationFn: ({ input, request }: { input: Input; request: Request }) => {
      if (getGlobalWorkspaceId() !== workspaceId || request.signal.aborted || !navigator.onLine)
        throw new Error('Workspace changed or offline');
      return perform(input, request);
    },
  });
  const current = (generation: number) => state.current.live &&
    state.current.generation === generation && getGlobalWorkspaceId() === workspaceId;
  async function run(input: Input) {
    if (!canWrite || uncertain || state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setMessage('Reconnect before saving changes.'); return; }
    const generation = state.current.generation;
    state.current.locked = true; state.current.controller = new AbortController(); setMessage(undefined);
    try {
      const result = await mutation.mutateAsync({ input, request: { signal: state.current.controller.signal, timeout: 20_000 } });
      await client.invalidateQueries({
        predicate: ({ queryKey: [path] }) => typeof path === 'string' &&
          (path === 'vulnerabilities' || /^\/api\/(vulnerabilities|targets|projects|statistic)(\/|$)/i.test(path)),
        refetchType: current(generation) ? 'active' : 'none',
      });
      if (current(generation)) onSuccess?.(result);
    } catch (error) {
      if (current(generation)) setMessage(unknownOutcome(error)
        ? 'Outcome unknown. Check saved state before trying again.' : 'Unable to save changes. Review the selection and try again.');
    } finally { state.current.locked = false; }
  }
  async function checkSaved(reload: () => Promise<unknown>) {
    if (state.current.locked || client.isMutating(filter) || getGlobalWorkspaceId() !== workspaceId) return;
    if (!navigator.onLine) { setMessage('Reconnect before checking saved state.'); return; }
    const generation = state.current.generation;
    state.current.locked = true; setChecking(true);
    try {
      await reload();
      if (!current(generation)) return;
      for (const failure of failures) client.getMutationCache().remove(failure);
      mutation.reset(); setMessage(undefined);
    } catch { if (current(generation)) setMessage('Unable to check saved state. Try again when connected.'); }
    finally { state.current.locked = false; if (current(generation)) setChecking(false); }
  }
  return { run, checkSaved, busy: pending || checking, uncertain,
    error: message ?? (uncertain ? 'Outcome unknown. Check saved state before trying again.' : undefined) };
}
