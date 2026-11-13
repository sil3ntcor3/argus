import { getGlobalWorkspaceId } from '@/utils/workspaceState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useEffect, useRef, useState } from 'react';

/** A lost response must survive dialog/page remounts without replaying a write. */
export function useProjectWorkflowAction(
  workspaceId: string,
  projectId: string,
  bindingId: string,
  action: 'run' | 'remove',
) {
  const client = useQueryClient();
  const key = [
    'project-workflow-outcome',
    workspaceId,
    projectId,
    bindingId,
    action,
  ];
  const outcome = useQuery<'idle' | 'pending' | 'unknown' | 'done'>({
    queryKey: key,
    queryFn: () => 'idle',
    enabled: false,
    initialData: 'idle',
    gcTime: Infinity,
  });
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const scope = `${workspaceId}:${projectId}:${bindingId}:${action}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, [scope]);
  const current = () =>
    mounted.current &&
    activeScope.current === scope &&
    workspaceId === getGlobalWorkspaceId();
  const isLocked = () => client.getQueryData(key) === 'pending';

  async function execute<T>(
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (!current() || client.getQueryData(key) !== 'idle') return;
    if (!navigator.onLine) {
      setError('You are offline. Reconnect before trying again.');
      return;
    }
    setError('');
    client.setQueryData(key, 'pending');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await request(controller.signal);
      client.setQueryData(key, 'done');
      return current() ? result : undefined;
    } catch (failure) {
      const status = isAxiosError(failure)
        ? failure.response?.status
        : undefined;
      const rejected =
        status !== undefined &&
        [400, 401, 403, 404, 409, 422, 429].includes(status);
      client.setQueryData(key, rejected ? 'idle' : 'unknown');
      if (current())
        setError(
          rejected
            ? 'The request was rejected. Refresh the project and check your access, tools and assets.'
            : 'Could not confirm the request completed. Check the project before making another request.',
        );
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }
  function acknowledge() {
    if (current() && outcome.data === 'unknown') {
      client.setQueryData(key, 'idle');
      setError('');
    }
  }
  const resetSuccess = () => {
    if (outcome.data === 'done') client.setQueryData(key, 'idle');
  };
  return {
    execute,
    acknowledge,
    resetSuccess,
    isLocked,
    error,
    busy: outcome.data === 'pending',
    uncertain: outcome.data === 'unknown',
    current,
  };
}
