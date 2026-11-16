import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGlobalWorkspaceId, setGlobalWorkspaceId, subscribeGlobalWorkspaceId } from '@/utils/workspaceState';
import { useSyncExternalStore } from 'react';
import { FindingSettings } from './finding-settings';
import { ClaimFixDialog } from './claim-fix-dialog';
import { findingPolicyChanges, validFindingPolicy } from '../finding-policy';
import type { VulnerabilitySettingsDto } from '@/services/apis/gen/queries';

const update = vi.fn(); const claim = vi.fn(); const reload = vi.fn(); const saved = vi.fn();
let allowed = true; let failed = false; let fresh = true;
let currentPolicy: VulnerabilitySettingsDto;
const defaults: VulnerabilitySettingsDto = { slaDays: { critical: 7, high: 30, medium: 90, low: 120, info: null },
  slaRestartOnResurface: true, autoCloseEnabled: true, autoCloseMissedScans: 1, riskAcceptMaxDays: 180 };
vi.mock('@/hooks/useWorkspaceSelector', () => ({ useWorkspaceSelector: () => ({
  selectedWorkspace: useSyncExternalStore(subscribeGlobalWorkspaceId, getGlobalWorkspaceId),
}) }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ hasPermission: () => allowed, isLoading: false, error: null }) }));
vi.mock('@/services/apis/gen/queries', async original => ({
  ...await original<typeof import('@/services/apis/gen/queries')>(),
  useVulnerabilitiesControllerGetSettings: () => ({ data: currentPolicy, isError: failed,
    isFetchedAfterMount: fresh, isFetching: false, refetch: reload }),
  vulnerabilitiesControllerUpdateSettings: (...args: unknown[]) => update(...args),
  vulnerabilitiesControllerClaimFix: (...args: unknown[]) => claim(...args),
}));
const mount = (content: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{content}</QueryClientProvider>);
describe('Finding lifecycle controls', () => {
  beforeEach(() => {
    vi.clearAllMocks(); allowed = true; failed = false; fresh = true;
    currentPolicy = defaults;
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    setGlobalWorkspaceId('A'); update.mockResolvedValue(defaults); claim.mockResolvedValue({ updated: 1 });
    reload.mockResolvedValue({ data: defaults, isError: false });
  });
  it('hides write controls when permissions are missing', () => {
    allowed = false;
    mount(<><FindingSettings /><ClaimFixDialog vulnerabilityIds={['finding']} trigger={<button>Mark fixed</button>} reload={reload} /></>);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('does not permit saving stale or failed policy reads', () => {
    fresh = false; const view = mount(<FindingSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Finding settings' }));
    expect(screen.getByText('Loading finding settings…')).toBeVisible();
    expect(screen.queryByText('Save settings')).toBeNull();
    failed = true; view.rerender(<QueryClientProvider client={new QueryClient()}><FindingSettings /></QueryClientProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load');
  });
  it('validates policy bounds and submits only edited keys, including explicit no-SLA', async () => {
    mount(<FindingSettings />); fireEvent.click(screen.getByRole('button', { name: 'Finding settings' }));
    fireEvent.change(screen.getByLabelText('critical days'), { target: { value: '0' } });
    expect(screen.getByText('Save settings')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('critical days'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('high days'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Maximum risk acceptance (days)'), { target: { value: '365' } });
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ slaDays: { high: null }, riskAcceptMaxDays: 365 }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });
  it('deduplicates a fix claim and records a bounded private note', async () => {
    mount(<ClaimFixDialog vulnerabilityIds={['finding', 'finding']} trigger={<button>Mark fixed</button>} reload={reload} onSuccess={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark fixed' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/They stay open/)).toBeVisible();
    const note = dialog.getByLabelText('What changed (optional)');
    fireEvent.change(note, { target: { value: 'x'.repeat(5001) } });
    expect(dialog.getByRole('button', { name: 'Mark fixed' })).toBeDisabled();
    fireEvent.change(note, { target: { value: ' Upgraded the affected package ' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Mark fixed' }));
    await waitFor(() => expect(claim).toHaveBeenCalledWith({ vulnerabilityIds: ['finding'], note: 'Upgraded the affected package' }, expect.anything()));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  });
  it('does not overwrite an untouched policy changed remotely during a draft', async () => {
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><FindingSettings /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Finding settings' }));
    fireEvent.change(screen.getByLabelText('high days'), { target: { value: '14' } });
    currentPolicy = { ...defaults, riskAcceptMaxDays: 365 };
    view.rerender(<QueryClientProvider client={client}><FindingSettings /></QueryClientProvider>);
    fireEvent.click(screen.getByText('Save settings'));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ slaDays: { high: 14 } }, expect.anything()));
  });
  it('closes a policy draft when switching workspaces', () => {
    mount(<FindingSettings />); fireEvent.click(screen.getByRole('button', { name: 'Finding settings' }));
    fireEvent.change(screen.getByLabelText('high days'), { target: { value: '99' } });
    act(() => setGlobalWorkspaceId('B'));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(update).not.toHaveBeenCalled();
  });
  it('preserves omitted fields and accepts only integer policy limits', () => {
    expect(findingPolicyChanges(defaults, { ...defaults, autoCloseMissedScans: 2 })).toEqual({ autoCloseMissedScans: 2 });
    expect(validFindingPolicy({ ...defaults, riskAcceptMaxDays: 3650 })).toBe(true);
    expect(validFindingPolicy({ ...defaults, riskAcceptMaxDays: Number.NaN })).toBe(false);
    expect(validFindingPolicy({ ...defaults, autoCloseMissedScans: 1.5 })).toBe(false);
  });
});
