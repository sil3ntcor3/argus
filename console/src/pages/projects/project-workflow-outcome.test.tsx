import {
  hashWorkspaceQueryKey,
  setGlobalWorkspaceId,
} from '@/utils/workspaceState';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useProjectWorkflowAction } from './use-project-workflow-action';

afterEach(() => setGlobalWorkspaceId(null));
describe('Workflow outcomes with real workspace cache hashing', () => {
  it.each(['failure', 'success'])(
    'settles a late %s in the originating workspace',
    async (kind) => {
      const client = new QueryClient({
        defaultOptions: { queries: { queryKeyHashFn: hashWorkspaceQueryKey } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      setGlobalWorkspaceId('workspace-a');
      const show = () =>
        renderHook(
          () =>
            useProjectWorkflowAction(
              'workspace-a',
              'project',
              'binding',
              'run',
            ),
          { wrapper },
        );
      const first = show();
      let finish!: (value: string) => void, fail!: (error: Error) => void;
      let pending!: Promise<unknown>;
      act(() => {
        pending = first.result.current.execute(
          () =>
            new Promise<string>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            }),
        );
      });
      setGlobalWorkspaceId('workspace-b');
      first.unmount();
      await act(async () => {
        if (kind === 'failure') fail(new Error('late abort'));
        else finish('old-run');
        await pending;
      });
      setGlobalWorkspaceId('workspace-a');
      const again = show();
      await waitFor(() => expect(again.result.current.busy).toBe(false));
      expect(again.result.current.uncertain).toBe(kind === 'failure');
      expect(client.getQueryCache().getAll()).toHaveLength(1);
      again.unmount();
      client.clear();
    },
  );
});
