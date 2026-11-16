import * as api from '@/services/apis/gen/queries';
import { usePermission } from '@/hooks/usePermission';
import { useWorkspaceState } from '@/hooks/useWorkspaceSelector';
import { getGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';
import { useIsMutating, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isAxiosError } from 'axios';
import { Button } from '@/components/ui/button';

class IssueWriteError extends Error {
  readonly cause: unknown;
  readonly uncertain: boolean;
  constructor(cause: unknown, uncertain: boolean) { super('Issue write failed'); this.cause=cause; this.uncertain=uncertain; }
}
const key = (workspace: string) => ['issue-write', workspace];
type CallOptions = { signal: AbortSignal; timeout: number };
type Callbacks<T, V> = { onSuccess?: (data: T, variables: V) => unknown; onError?: (error: unknown) => unknown; onSettled?: () => unknown };

/** Never queue/retry a write or deliver callbacks into a different workspace. */
export function useIssueMutation<V, T>(perform: (variables: V, options: CallOptions) => Promise<T>) {
  const { state: { selectedWorkspaceId: workspace } } = useWorkspaceState();
  const permission = usePermission();
  const client = useQueryClient();
  const pending = useIsMutating({ mutationKey: key(workspace), exact: true });
  const failures = useMutationState({ filters: { mutationKey: key(workspace), exact: true, status: 'error' }, select: mutation => mutation.state.error });
  const uncertain = failures.some(error => error instanceof IssueWriteError && error.uncertain);
  const scope = useRef({ live: true, generation: 0, busy: false, controller: new AbortController() });
  const allowed = useRef(false);
  allowed.current = !permission.error && !permission.isLoading && !permission.isFetching && permission.hasPermission('workspace.write');
  useEffect(() => {
    const state = scope.current; state.live = true;
    const cancel = () => { state.generation++; state.controller.abort(); };
    const unsubscribe = subscribeGlobalWorkspaceId(cancel);
    return () => { state.live = false; cancel(); unsubscribe(); };
  }, []);
  const mutation = useMutation({ mutationKey: key(workspace), retry: false, networkMode: 'always', onError: () => {},
    mutationFn: async (variables: V) => {
      if (!allowed.current || getGlobalWorkspaceId() !== workspace || !navigator.onLine || scope.current.controller.signal.aborted)
        throw new IssueWriteError(new Error('Reconnect and check workspace access'), false);
      try { return await perform(variables, { signal: scope.current.controller.signal, timeout: 20_000 }); }
      catch (cause) {
        const status = isAxiosError(cause) ? cause.response?.status : undefined;
        throw new IssueWriteError(cause, status === undefined || status === 403 || status === 404 || status === 408 || status >= 500);
      }
    },
  });
  const mutate = (variables: V, callbacks: Callbacks<T, V> = {}) => {
    const state = scope.current;
    if (!allowed.current || uncertain || state.busy || client.isMutating({ mutationKey: key(workspace), exact: true }) || getGlobalWorkspaceId() !== workspace) return;
    const generation = state.generation;
    const current = () => state.live && generation === state.generation && getGlobalWorkspaceId() === workspace;
    state.busy = true; state.controller = new AbortController();
    void mutation.mutateAsync(variables).then(async result => {
      if (current()) await callbacks.onSuccess?.(result, variables);
    }, error => { if (current()) callbacks.onError?.(error instanceof IssueWriteError ? error.cause : error); })
      .catch(() => {}).finally(() => { state.busy = false; if (current()) callbacks.onSettled?.(); });
  };
  return { ...mutation, mutate, isPending: Boolean(pending) || mutation.isPending || uncertain || !allowed.current };
}

export function IssueWriteHint() {
  const { state: { selectedWorkspaceId: workspace } } = useWorkspaceState();
  const failures = useMutationState({ filters: { mutationKey: key(workspace), exact: true, status: 'error' }, select: mutation => mutation.state.error });
  return failures.some(error => error instanceof IssueWriteError && error.uncertain)
    ? <p role="alert" className="text-sm text-destructive">Outcome unknown. Close this dialog and check saved issues before starting again.</p> : null;
}

/** A checked unknown outcome must be explicitly discarded before another write. */
export function useIssuesCanWrite() {
  const access = usePermission();
  return !access.error && !access.isLoading && !access.isFetching && access.hasPermission('workspace.write');
}

export function IssueBoundary({ children }: { children: ReactNode }) {
  const { state: { selectedWorkspaceId: workspace } } = useWorkspaceState();
  return <ScopedIssueBoundary key={workspace} workspace={workspace}>{children}</ScopedIssueBoundary>;
}
function ScopedIssueBoundary({ workspace, children }: { workspace: string; children: ReactNode }) {
  const client = useQueryClient();
  const permission = usePermission();
  const failures = useMutationState({ filters: { mutationKey: key(workspace), exact: true, status: 'error' }, select: mutation => mutation });
  const pending = useIsMutating({ mutationKey: key(workspace), exact: true });
  const uncertain = failures.some(mutation => mutation.state.error instanceof IssueWriteError && mutation.state.error.uncertain);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [revision, setRevision] = useState(0);
  if (!workspace) return <p>Select a workspace to view issues.</p>;
  if (permission.isLoading) return <p>Loading issue access…</p>;
  if (permission.error) return <p role="alert">Unable to confirm issue access. Refresh to try again.</p>;
  if (!permission.hasPermission('workspace.read')) return <p role="alert">You do not have access to issues.</p>;
  const check = async () => {
    if (!navigator.onLine || pending || getGlobalWorkspaceId() !== workspace) return;
    setChecking(true); setChecked(false); setCheckError(false);
    try {
      await Promise.all([api.issuesControllerGetMany({ page: 1, limit: 20 }, { timeout: 20_000 }), api.issueRulesControllerListRules({ timeout: 20_000 })]);
      if (getGlobalWorkspaceId() !== workspace) return;
      await client.invalidateQueries({ predicate: query => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/api/issues') });
      if (getGlobalWorkspaceId() === workspace) setChecked(true);
    } catch { if (getGlobalWorkspaceId() === workspace) setCheckError(true); }
    finally { if (getGlobalWorkspaceId() === workspace) setChecking(false); }
  };
  return <>
    {uncertain && <div role="alert" className="m-4 space-y-2 rounded border p-3 text-sm">
      <p>Outcome unknown. The request may have saved. Check the Issues list, detail and rules before starting again.</p>
      {checkError && <p>Unable to check saved issues. Reconnect or refresh your access.</p>}
      <Button variant="outline" disabled={Boolean(pending) || checking} onClick={() => void check()}>Check saved issues</Button>
      {checked && <Button variant="outline" disabled={Boolean(pending)} onClick={() => {
        if (getGlobalWorkspaceId() !== workspace) return;
        failures.forEach(mutation => client.getMutationCache().remove(mutation));
        setChecked(false); setRevision(value => value + 1);
      }}>Discard uncertain submission</Button>}
    </div>}
    <div key={revision}>{children}</div>
  </>;
}

export function useIssuesControllerCreate() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerCreate>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerCreate(variables.data, options);
  });
}

export function useIssuesControllerUpdate() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerUpdate>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerUpdate(variables.id, variables.data, options);
  });
}

export function useIssuesControllerDelete() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerDelete>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerDelete(variables.id, options);
  });
}

export function useIssuesControllerChangeStatus() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerChangeStatus>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerChangeStatus(variables.id, variables.data, options);
  });
}

export function useIssuesControllerAddLinks() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerAddLinks>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerAddLinks(variables.id, variables.data, options);
  });
}

export function useIssuesControllerRemoveLink() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssuesControllerRemoveLink>['mutate']>[0], options: CallOptions) => {
    return api.issuesControllerRemoveLink(variables.id, variables.linkId, options);
  });
}

export function useIssueRulesControllerCreateRule() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssueRulesControllerCreateRule>['mutate']>[0], options: CallOptions) => {
    return api.issueRulesControllerCreateRule(variables.data, options);
  });
}

export function useIssueRulesControllerUpdateRule() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssueRulesControllerUpdateRule>['mutate']>[0], options: CallOptions) => {
    return api.issueRulesControllerUpdateRule(variables.id, variables.data, options);
  });
}

export function useIssueRulesControllerDeleteRule() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssueRulesControllerDeleteRule>['mutate']>[0], options: CallOptions) => {
    return api.issueRulesControllerDeleteRule(variables.id, options);
  });
}

export function useIssueRulesControllerCreateDefaultRules() {
  return useIssueMutation((variables: Parameters<ReturnType<typeof api.useIssueRulesControllerCreateDefaultRules>['mutate']>[0], options: CallOptions) => {
    return api.issueRulesControllerCreateDefaultRules(options);
  });
}
