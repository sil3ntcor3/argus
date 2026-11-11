import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableSidePanel } from './side-panel-resizer';

const widthKey = 'agent-side-panel-width';

function Split() {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef}>
      <ResizableSidePanel rowRef={rowRef}>Panel content</ResizableSidePanel>
    </div>
  );
}

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function dividerAndPanel() {
  const divider = screen.getByRole('separator', { name: 'Resize side panel' });
  const panel = screen.getByRole('complementary');
  return { divider, panel };
}

describe('ResizableSidePanel', () => {
  let rowWidth: number;

  beforeEach(() => {
    localStorage.removeItem(widthKey);
    rowWidth = 1400;
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      () => rowWidth,
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 500,
    } as DOMRect);
  });

  afterEach(() => {
    localStorage.removeItem(widthKey);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resizes with the keyboard, exposes its panel, and persists until reset', () => {
    const { unmount } = render(<Split />);
    const { divider, panel } = dividerAndPanel();
    expect(divider).toHaveAttribute('aria-controls', panel.id);
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(panel.style.width).toBe('524px');
    expect(divider).toHaveAttribute('aria-valuenow', '524');
    expect(localStorage.getItem(widthKey)).toBe('524');

    unmount();
    render(<Split />);
    const reopened = dividerAndPanel();
    expect(reopened.panel.style.width).toBe('524px');
    fireEvent.keyDown(reopened.divider, { key: 'Enter' });
    expect(reopened.panel.style.width).toBe('');
    expect(localStorage.getItem(widthKey)).toBeNull();
  });

  it('bounds drag width and restores the committed width after pointer cancellation', () => {
    render(<Split />);
    const { divider, panel } = dividerAndPanel();
    Object.assign(divider, { setPointerCapture: vi.fn() });
    fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
    fireEvent.pointerMove(divider, { clientX: 0 });
    expect(panel.style.width).toBe('980px');
    fireEvent.pointerUp(divider, { clientX: 0 });
    expect(localStorage.getItem(widthKey)).toBe('980');

    fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
    fireEvent.pointerMove(divider, { clientX: 950 });
    fireEvent.pointerCancel(divider);
    expect(panel.style.width).toBe('980px');
    expect(localStorage.getItem(widthKey)).toBe('980');
  });

  it('preserves the saved width when resizing outward at a narrow desktop limit', () => {
    rowWidth = 760;
    localStorage.setItem(widthKey, '900');
    render(<Split />);
    const { divider, panel } = dividerAndPanel();
    expect(panel.style.width).toBe('340px');
    expect(divider).toHaveAttribute('aria-valuemax', '340');

    vi.mocked(panel.getBoundingClientRect).mockReturnValue({
      width: 340,
    } as DOMRect);
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(localStorage.getItem(widthKey)).toBe('900');

    Object.assign(divider, { setPointerCapture: vi.fn() });
    fireEvent.pointerDown(divider, { button: 0, clientX: 420 });
    fireEvent.pointerMove(divider, { clientX: 400 });
    fireEvent.pointerUp(divider, { clientX: 400 });
    expect(localStorage.getItem(widthKey)).toBe('900');
  });
});
