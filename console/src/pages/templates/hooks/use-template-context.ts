import { useEffect, useRef } from 'react';
import { getGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';

/** A workspace switch invalidates pending callbacks even after switching back. */
export function useTemplateContext({ keepWritesAlive = false } = {}) {
  const workspace = useRef(getGlobalWorkspaceId());
  const state = useRef({ generation: 0, live: true, controller: new AbortController() });
  useEffect(() => {
    const current = state.current;
    current.live = true;
    current.controller = new AbortController();
    const invalidate = () => {
      current.generation++;
      if (!keepWritesAlive) current.controller.abort();
    };
    const unsubscribe = subscribeGlobalWorkspaceId(invalidate);
    return () => { current.live = false; invalidate(); unsubscribe(); };
  }, [keepWritesAlive]);
  return {
    request: { timeout: 20_000, get signal() { return state.current.controller.signal; } },
    capture: () => {
      const generation = state.current.generation;
      const workspaceId = getGlobalWorkspaceId();
      return () => state.current.live && !state.current.controller.signal.aborted && generation === state.current.generation && getGlobalWorkspaceId() === workspaceId && workspace.current === workspaceId;
    },
  };
}
