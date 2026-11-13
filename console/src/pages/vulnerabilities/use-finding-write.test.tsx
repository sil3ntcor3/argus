import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { useFindingWrite } from './use-finding-write';

describe('Finding write boundaries', () => {
  const perform = vi.fn();
  const reload = vi.fn();
  const saved = vi.fn();
  let client: QueryClient;
  let writable = true;
  const globalError = vi.fn();
  function Form() {
    const write = useFindingWrite({ workspaceId: 'A', operation: 'fixture', canWrite: writable,
      perform, onSuccess: saved });
    return <><button onClick={() => void write.run('input')} disabled={write.busy || write.uncertain}>Save</button>
      <button onClick={() => void write.checkSaved(reload)}>Check saved state</button>
      {write.error && <p role="alert">{write.error}</p>}</>;
  }
  const mount = () => render(<QueryClientProvider client={client}><Form /></QueryClientProvider>);
  beforeEach(() => {
    vi.resetAllMocks(); writable = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    setGlobalWorkspaceId('A');
    client = new QueryClient({ defaultOptions: { mutations: { retry: false, onError: globalError } } });
    perform.mockResolvedValue({ updated: 1 }); reload.mockResolvedValue(undefined);
  });
  it('never queues writes offline or without permission', async () => {
    const view = mount();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    fireEvent.click(screen.getByText('Save'));
    expect(perform).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    writable = false; view.rerender(<QueryClientProvider client={client}><Form /></QueryClientProvider>);
    fireEvent.click(screen.getByText('Save'));
    expect(perform).not.toHaveBeenCalled();
  });
  it('locks duplicate submits and ignores late effects across A → B → A', async () => {
    let resolve!: (value: unknown) => void;
    perform.mockImplementation(() => new Promise(done => { resolve = done; }));
    mount();
    fireEvent.click(screen.getByText('Save')); fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    const options = perform.mock.calls[0][1] as { signal: AbortSignal };
    act(() => { setGlobalWorkspaceId('B'); setGlobalWorkspaceId('A'); });
    expect(options.signal.aborted).toBe(true);
    await act(async () => resolve({ updated: 1 }));
    expect(saved).not.toHaveBeenCalled();
  });
  it('retains an ambiguous outcome across remounts until a successful saved-state check', async () => {
    perform.mockRejectedValue(new AxiosError('Response lost'));
    const view = mount(); fireEvent.click(screen.getByText('Save'));
    await screen.findByRole('alert');
    expect(globalError).not.toHaveBeenCalled();
    expect(screen.getByText('Save')).toBeDisabled();
    view.unmount(); mount();
    expect(screen.getByText('Save')).toBeDisabled();
    reload.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(screen.getByText('Check saved state'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Save')).toBeDisabled();
    fireEvent.click(screen.getByText('Check saved state'));
    await waitFor(() => expect(screen.getByText('Save')).not.toBeDisabled());
  });
});
