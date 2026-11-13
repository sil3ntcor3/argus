import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { useReviewWrite } from './use-review-write';

describe('Review write boundaries',()=>{
  const perform=vi.fn(),reload=vi.fn(),saved=vi.fn(),discarded=vi.fn(),persisted=vi.fn();
  let client:QueryClient;let writable=true;let partial=false;
  function Form() {
    const write=useReviewWrite({ workspaceId:'A',canWrite:writable,perform,onSuccess:saved,onDiscard:discarded,onPersisted:persisted,partial });
    return <><button disabled={write.busy||write.uncertain} onClick={()=>void write.run('decision')}>Review</button>
      <button disabled={write.busy} onClick={()=>void write.checkSaved(reload)}>Check state</button>
      <button disabled={!write.reviewed||write.busy} onClick={write.discard}>Discard local attempt</button>
      {write.error&&<p role="alert">{write.error}</p>}</>;
  }
  const mount=()=>render(<QueryClientProvider client={client}><Form/></QueryClientProvider>);
  beforeEach(()=>{
    vi.resetAllMocks();writable=true;partial=false;setGlobalWorkspaceId('A');
    Object.defineProperty(navigator,'onLine',{ configurable:true,value:true });
    client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } });
    perform.mockResolvedValue({ reviewed:[] });reload.mockResolvedValue(undefined);
  });
  it('does not queue offline or permissionless decisions',async()=>{
    const view=mount();Object.defineProperty(navigator,'onLine',{ configurable:true,value:false });
    fireEvent.click(screen.getByText('Review'));expect(perform).not.toHaveBeenCalled();
    writable=false;Object.defineProperty(navigator,'onLine',{ configurable:true,value:true });
    view.rerender(<QueryClientProvider client={client}><Form/></QueryClientProvider>);
    fireEvent.click(screen.getByText('Review'));expect(perform).not.toHaveBeenCalled();
  });
  it('serializes decisions and drops stale callbacks across workspace changes',async()=>{
    let resolve!:(value:unknown)=>void;perform.mockImplementation(()=>new Promise(done=>{ resolve=done; }));mount();
    fireEvent.click(screen.getByText('Review'));fireEvent.click(screen.getByText('Review'));
    await waitFor(()=>expect(perform).toHaveBeenCalledTimes(1));
    act(()=>{ setGlobalWorkspaceId('B');setGlobalWorkspaceId('A'); });
    expect(perform.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async()=>resolve({ reviewed:[] }));expect(saved).not.toHaveBeenCalled();
  });
  it('never unlocks or replays a partial bulk outcome after a partial read or remount',async()=>{
    perform.mockRejectedValue(new AxiosError('Response lost'));const view=mount();fireEvent.click(screen.getByText('Review'));
    await screen.findByRole('alert');view.unmount();mount();
    expect(screen.getByText('Review')).toBeDisabled();
    reload.mockRejectedValueOnce(new Error('Partial refresh failed'));fireEvent.click(screen.getByText('Check state'));
    await waitFor(()=>expect(reload).toHaveBeenCalledTimes(1));expect(screen.getByText('Discard local attempt')).toBeDisabled();
    fireEvent.click(screen.getByText('Check state'));await waitFor(()=>expect(screen.getByText('Discard local attempt')).not.toBeDisabled());
    expect(screen.getByText('Review')).toBeDisabled();expect(perform).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Discard local attempt'));await waitFor(()=>expect(screen.getByText('Review')).not.toBeDisabled());
    expect(discarded).toHaveBeenCalledTimes(1);expect(perform).toHaveBeenCalledTimes(1);
  });
  it('holds the write lock through refresh and reports known validation failures without replay',async()=>{
    let finish!:()=>void;vi.spyOn(client,'invalidateQueries').mockImplementation(()=>new Promise<void>(done=>{ finish=done; }));mount();
    fireEvent.click(screen.getByText('Review'));await waitFor(()=>expect(client.invalidateQueries).toHaveBeenCalled());
    expect(screen.getByText('Review')).toBeDisabled();await act(async()=>finish());await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));
    perform.mockRejectedValueOnce(new AxiosError('Conflict','409',undefined,undefined,{ status:409 } as never));
    fireEvent.click(screen.getByText('Review'));await screen.findByRole('alert');
    expect(screen.getByText('Review')).not.toBeDisabled();expect(perform).toHaveBeenCalledTimes(2);
  });
  it('awaits target navigation before invalidating a deleted proposal detail',async()=>{
    let finish!:()=>void;persisted.mockImplementation(()=>new Promise<void>(done=>{ finish=done; }));
    const invalidate=vi.spyOn(client,'invalidateQueries').mockResolvedValue();mount();fireEvent.click(screen.getByText('Review'));
    await waitFor(()=>expect(persisted).toHaveBeenCalledTimes(1));expect(invalidate).not.toHaveBeenCalled();
    expect(screen.getByText('Review')).toBeDisabled();await act(async()=>finish());
    await waitFor(()=>expect(invalidate).toHaveBeenCalledTimes(1));
  });
  it('retains a potentially partial bulk failure even when its final response is 403',async()=>{
    partial=true;perform.mockRejectedValueOnce(new AxiosError('Access changed','403',undefined,undefined,{ status:403 } as never));
    mount();fireEvent.click(screen.getByText('Review'));await screen.findByRole('alert');
    expect(screen.getByText('Review')).toBeDisabled();expect(perform).toHaveBeenCalledTimes(1);
  });
});
