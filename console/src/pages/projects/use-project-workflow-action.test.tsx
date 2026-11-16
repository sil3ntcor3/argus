import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectWorkflowAction } from './use-project-workflow-action';

const mock = vi.hoisted(() => ({ workspace: vi.fn(() => 'workspace') }));
vi.mock('@/utils/workspaceState', () => ({
  getGlobalWorkspaceId: mock.workspace,
}));
afterEach(() => {
  vi.restoreAllMocks();
  mock.workspace.mockReturnValue('workspace');
});
function setup(client = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    wrapper,
    ...renderHook(
      ({ project }) =>
        useProjectWorkflowAction('workspace', project, 'binding', 'run'),
      { wrapper, initialProps: { project: 'project' } },
    ),
  };
}

describe('Project workflow action safety', () => {
  it('sends one request for same-tick duplicate confirmations and does not replay a success', async () => {
    const f = setup();
    let finish!: (value: string) => void;
    const request = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    let pending: Promise<unknown>;
    act(() => {
      pending = f.result.current.execute(request);
      void f.result.current.execute(request);
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish('run-id');
      await pending;
    });
    await act(async () => {
      await f.result.current.execute(request);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown outcomes after remount and requires explicit acknowledgement', async () => {
    const f = setup();
    const request = vi.fn().mockRejectedValue(new Error('lost receipt'));
    await act(async () => {
      await f.result.current.execute(request);
    });
    await waitFor(() => expect(f.result.current.uncertain).toBe(true));
    f.unmount();
    const again = setup(f.client);
    expect(again.result.current.uncertain).toBe(true);
    await act(async () => {
      await again.result.current.execute(request);
    });
    expect(request).toHaveBeenCalledTimes(1);
    act(() => again.result.current.acknowledge());
    await waitFor(() => expect(again.result.current.uncertain).toBe(false));
    await act(async () => {
      await again.result.current.execute(request);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('blocks offline writes without queuing them', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const f = setup(),
      request = vi.fn();
    await act(async () => {
      await f.result.current.execute(request);
    });
    expect(request).not.toHaveBeenCalled();
    expect(f.result.current.error).toMatch(/offline/);
  });
  it('allows a corrected request after an authoritative rejection', async () => {
    const f = setup();
    const request = vi
      .fn()
      .mockRejectedValue({ isAxiosError: true, response: { status: 400 } });
    await act(async () => {
      await f.result.current.execute(request);
    });
    expect(f.result.current.uncertain).toBe(false);
    await act(async () => {
      await f.result.current.execute(request);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('suppresses stale successes after a workspace switch', async () => {
    const f = setup();
    let finish!: (value: string) => void;
    const request = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      });
    let pending!: Promise<unknown>;
    act(() => {
      pending = f.result.current.execute(request);
    });
    mock.workspace.mockReturnValue('other-workspace');
    let result: unknown = 'unsettled';
    await act(async () => {
      finish('old-run');
      result = await pending;
    });
    expect(result).toBeUndefined();
  });
  it('aborts on project replacement and suppresses the old receipt', async () => {
    const f = setup();
    let finish!: (value: string) => void;
    let signal!: AbortSignal;
    let pending!: Promise<unknown>;
    act(() => {
      pending = f.result.current.execute((s) => {
        signal = s;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
    });
    f.rerender({ project: 'other-project' });
    expect(signal.aborted).toBe(true);
    let result: unknown = 'unsettled';
    await act(async () => {
      finish('old-run');
      result = await pending;
    });
    expect(result).toBeUndefined();
    expect(f.result.current.uncertain).toBe(false);
  });
});
