import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setGlobalWorkspaceId } from '@/utils/workspaceState';
import { ReviewDialog } from './review-dialog';

const api=vi.hoisted(()=>({ approve:vi.fn(),reject:vi.fn(),merge:vi.fn(),bulkApprove:vi.fn(),bulkReject:vi.fn(),duplicates:vi.fn() }));
let writable=true;
vi.mock('@/hooks/usePermission',()=>({ usePermission:()=>({ isLoading:false,error:null,hasPermission:()=>writable }) }));
vi.mock('@/hooks/useWorkspaceSelector',()=>({ useWorkspaceSelector:()=>({ selectedWorkspace:'A' }) }));
vi.mock('@/services/apis/gen/queries',()=>({
  vulnerabilitiesControllerApprove:api.approve,vulnerabilitiesControllerReject:api.reject,vulnerabilitiesControllerMerge:api.merge,
  vulnerabilitiesControllerBulkApprove:api.bulkApprove,vulnerabilitiesControllerBulkReject:api.bulkReject,vulnerabilitiesControllerDuplicates:api.duplicates,
}));
describe('Finding review dialog',()=>{
  const reload=vi.fn(),saved=vi.fn();
  const mount=(mode:'approve'|'reject'|'merge',ids=['proposal'])=>render(<QueryClientProvider client={new QueryClient({ defaultOptions:{ queries:{ retry:false } } })}>
    <ReviewDialog ids={ids} mode={mode} trigger={<button>Open review</button>} reload={reload} onSuccess={saved}/>
  </QueryClientProvider>);
  beforeEach(()=>{
    vi.resetAllMocks();writable=true;setGlobalWorkspaceId('A');Object.defineProperty(navigator,'onLine',{ configurable:true,value:true });
    api.approve.mockResolvedValue({ id:'proposal',reviewStatus:'approved' });api.reject.mockResolvedValue({ id:'proposal',reviewStatus:'rejected' });
    api.bulkApprove.mockResolvedValue({ reviewed:[{ id:'one' }],skipped:[{ id:'two',reason:'No longer pending review' }] });
    api.bulkReject.mockResolvedValue({ reviewed:[{ id:'one' }],skipped:[] });
    api.merge.mockResolvedValue({ targetVulnerabilityId:'target',movedSources:1 });
    api.duplicates.mockResolvedValue({ data:[{ id:'target',name:'Existing SQL injection',severity:'high',reasons:['name','cwe'],detectionStatus:'active' }] });
    reload.mockResolvedValue(undefined);
  });
  it('approves a single proposal with an optional severity override and bounded note',async()=>{
    mount('approve');fireEvent.click(screen.getByText('Open review'));
    const dialog=screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Severity'),{ target:{ value:'critical' } });
    fireEvent.change(within(dialog).getByLabelText('Review note (optional)'),{ target:{ value:'  Reproduced  ' } });
    fireEvent.click(within(dialog).getByRole('button',{ name:'Approve proposal' }));
    await waitFor(()=>expect(api.approve).toHaveBeenCalledWith('proposal',{ severity:'critical',note:'Reproduced' },expect.objectContaining({ signal:expect.any(AbortSignal),timeout:20000 })));
    await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('requires a nonblank rejection reason',async()=>{
    mount('reject');fireEvent.click(screen.getByText('Open review'));const dialog=screen.getByRole('dialog');
    const submit=within(dialog).getByRole('button',{ name:'Reject proposal' });expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Rejection reason'),{ target:{ value:'   ' } });expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Rejection reason'),{ target:{ value:'False positive' } });
    fireEvent.click(submit);await waitFor(()=>expect(api.reject).toHaveBeenCalledWith('proposal',{ note:'False positive' },expect.any(Object)));
  });
  it('uses bulk APIs and reports skipped decisions without replaying them',async()=>{
    mount('approve',['one','two','one']);fireEvent.click(screen.getByText('Open review'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{ name:'Approve proposals' }));
    await waitFor(()=>expect(api.bulkApprove).toHaveBeenCalledWith({ ids:['one','two'] },expect.any(Object)));
    expect(api.approve).not.toHaveBeenCalled();await waitFor(()=>expect(saved).toHaveBeenCalledWith(expect.objectContaining({ skipped:[expect.any(Object)] })));
  });
  it('offers only returned duplicate targets and disables merge until selected',async()=>{
    mount('merge');fireEvent.click(screen.getByText('Open review'));const dialog=screen.getByRole('dialog');
    const submit=within(dialog).getByRole('button',{ name:'Merge proposal' });expect(submit).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole('radio',{ name:/Existing SQL injection/ }));
    fireEvent.click(submit);await waitFor(()=>expect(api.merge).toHaveBeenCalledWith('proposal',{ targetVulnerabilityId:'target' },expect.any(Object)));
  });
  it('supports duplicate-loading errors, retry and an empty result',async()=>{
    api.duplicates.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ data:[] });
    mount('merge');fireEvent.click(screen.getByText('Open review'));
    await screen.findByText('Unable to load duplicate candidates.');fireEvent.click(screen.getByRole('button',{ name:'Retry candidates' }));
    await screen.findByText('No matching approved findings on this asset.');
    expect(screen.getByRole('button',{ name:'Merge proposal' })).toBeDisabled();
  });
  it('hides review controls without write access and never queues an offline decision',async()=>{
    writable=false;const view=mount('approve');expect(screen.queryByText('Open review')).not.toBeInTheDocument();view.unmount();
    writable=true;mount('approve');fireEvent.click(screen.getByText('Open review'));
    Object.defineProperty(navigator,'onLine',{ configurable:true,value:false });fireEvent.click(screen.getByRole('button',{ name:'Approve proposal' }));
    await screen.findByText('Reconnect before reviewing findings.');expect(api.approve).not.toHaveBeenCalled();
  });
});
