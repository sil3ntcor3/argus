import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider, SidebarTrigger, useSidebar } from './sidebar';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => viewport.mobile,
}));

/** Exposes provider state while exercising the real sidebar trigger. */
function SidebarState() {
  const { state, openMobile } = useSidebar();
  return (
    <>
      <output aria-label="Desktop state">{state}</output>
      <output aria-label="Mobile state">{openMobile ? 'open' : 'closed'}</output>
      <SidebarTrigger />
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  viewport.mobile = false;
});
afterEach(() => vi.restoreAllMocks());

describe('SidebarProvider preference compatibility', () => {
  it.each([true, false])('retains the saved legacy preference %s', (open) => {
    localStorage.setItem('oasm_sidebar_state', String(open));
    render(<SidebarProvider defaultOpen={!open}><SidebarState /></SidebarProvider>);

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent(open ? 'expanded' : 'collapsed');
    expect(localStorage.getItem('argus_sidebar_state')).toBeNull();
  });

  it.each([true, false])('uses defaultOpen=%s without a saved preference', (open) => {
    render(<SidebarProvider defaultOpen={open}><SidebarState /></SidebarProvider>);

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent(open ? 'expanded' : 'collapsed');
  });

  it('uses defaultOpen when storage reads are unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
    render(<SidebarProvider defaultOpen={false}><SidebarState /></SidebarProvider>);

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent('collapsed');
  });

  it('keeps controlled open state and invokes onOpenChange', () => {
    localStorage.setItem('oasm_sidebar_state', 'true');
    const onOpenChange = vi.fn();
    render(<SidebarProvider open={false} onOpenChange={onOpenChange}><SidebarState /></SidebarProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText('Desktop state')).toHaveTextContent('collapsed');
  });

  it('keeps mobile toggling separate from the saved desktop preference', () => {
    viewport.mobile = true;
    localStorage.setItem('oasm_sidebar_state', 'false');
    render(<SidebarProvider><SidebarState /></SidebarProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));

    expect(screen.getByLabelText('Mobile state')).toHaveTextContent('open');
    expect(screen.getByLabelText('Desktop state')).toHaveTextContent('collapsed');
    expect(localStorage.getItem('oasm_sidebar_state')).toBe('false');
    expect(localStorage.getItem('argus_sidebar_state')).toBeNull();
  });

  it('retains the desktop keyboard shortcut', () => {
    render(<SidebarProvider defaultOpen={false}><SidebarState /></SidebarProvider>);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent('expanded');
  });
});

describe('Argus sidebar preference', () => {
  it.each([true, false])('prefers the Argus value %s over a conflicting legacy value', (open) => {
    localStorage.setItem('argus_sidebar_state', String(open));
    localStorage.setItem('oasm_sidebar_state', String(!open));
    render(<SidebarProvider><SidebarState /></SidebarProvider>);

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent(open ? 'expanded' : 'collapsed');
  });

  it.each([true, false])('reads the Argus preference %s without a legacy value', (open) => {
    localStorage.setItem('argus_sidebar_state', String(open));
    render(<SidebarProvider defaultOpen={!open}><SidebarState /></SidebarProvider>);

    expect(screen.getByLabelText('Desktop state')).toHaveTextContent(open ? 'expanded' : 'collapsed');
  });

  it('persists toggles under Argus and restores them after remount without changing legacy storage', () => {
    localStorage.setItem('oasm_sidebar_state', 'false');
    const { unmount } = render(<SidebarProvider><SidebarState /></SidebarProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));

    expect(localStorage.getItem('argus_sidebar_state')).toBe('true');
    expect(localStorage.getItem('oasm_sidebar_state')).toBe('false');
    unmount();
    render(<SidebarProvider><SidebarState /></SidebarProvider>);
    expect(screen.getByLabelText('Desktop state')).toHaveTextContent('expanded');
  });
});
