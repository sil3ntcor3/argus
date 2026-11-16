import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueBoundary, useIssueMutation } from './issue-api';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
vi.mock('@/services/apis/gen/queries', async importOriginal => ({ ...await importOriginal<typeof import('@/services/apis/gen/queries')>(), issuesControllerGetMany: vi.fn().mockResolvedValue({data:[]}), issueRulesControllerListRules: vi.fn().mockResolvedValue([]) }));
const access=vi.hoisted(()=>({write:true}));
vi.mock('@/hooks/usePermission',()=>({usePermission:()=>({hasPermission:(key:string)=>key.endsWith('.read')||access.write,isLoading:false,isFetching:false})}));
type Perform = (input: undefined, options: { signal: AbortSignal; timeout: number }) => Promise<unknown>;
function mount(perform: ReturnType<typeof vi.fn<Perform>>, saved=vi.fn(), defaultError=vi.fn()) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false,onError:defaultError}}});
  function Form() {
    const write=useIssueMutation<undefined, unknown>(perform);
    return <button disabled={write.isPending} onClick={()=>write.mutate(undefined,{onSuccess:saved})}>Submit issue</button>;
  }
  const view=render(<QueryClientProvider client={client}><IssueBoundary><Form /></IssueBoundary></QueryClientProvider>);
  return {...view,client,saved,defaultError};
}
beforeEach(()=>{setGlobalWorkspaceId('issue-A');access.write=true;});
afterEach(()=>{vi.restoreAllMocks();setGlobalWorkspaceId(null);});
describe('Issue write safety',()=>{
 it('does not queue offline work or send read-only writes',async()=>{
   const perform=vi.fn<Perform>();const {rerender}=mount(perform);
   const online=vi.spyOn(navigator,'onLine','get').mockReturnValue(false);
   fireEvent.click(screen.getByText('Submit issue'));await waitFor(()=>expect(screen.getByText('Submit issue')).not.toBeDisabled());
   expect(perform).not.toHaveBeenCalled();online.mockRestore();access.write=false;
   rerender(<QueryClientProvider client={new QueryClient()}><IssueBoundary><p>Read only</p></IssueBoundary></QueryClientProvider>);
   expect(perform).not.toHaveBeenCalled();
 });
 it('serializes duplicate submissions and drops callbacks after a workspace switch',async()=>{
   let finish!:(value:unknown)=>void;const perform=vi.fn<Perform>(()=>new Promise(resolve=>{finish=resolve;}));
   const {saved,defaultError}=mount(perform);fireEvent.click(screen.getByText('Submit issue'));fireEvent.click(screen.getByText('Submit issue'));
   await waitFor(()=>expect(perform).toHaveBeenCalledTimes(1));
   act(()=>setGlobalWorkspaceId('issue-B'));await act(async()=>finish({id:'saved'}));
   expect(saved).not.toHaveBeenCalled();expect(defaultError).not.toHaveBeenCalled();expect(perform.mock.calls[0]![1].signal.aborted).toBe(true);
 });
 it('requires checking and explicit discard after an unknown outcome without repeating the request',async()=>{
   const perform=vi.fn<Perform>().mockRejectedValue(new Error('connection lost'));mount(perform);
   fireEvent.click(screen.getByText('Submit issue'));
   await screen.findByText(/Outcome unknown/);expect(perform).toHaveBeenCalledTimes(1);
   fireEvent.click(screen.getByText('Submit issue'));expect(perform).toHaveBeenCalledTimes(1);
   expect(screen.queryByText('Discard uncertain submission')).toBeNull();
   fireEvent.click(screen.getByText('Check saved issues'));
   fireEvent.click(await screen.findByText('Discard uncertain submission'));
   await waitFor(()=>expect(screen.getByText('Submit issue')).not.toBeDisabled());
   expect(perform).toHaveBeenCalledTimes(1);
 });
});
