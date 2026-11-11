import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler, useRef } from 'react';
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

function watchResize() {
  let notify = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  return () => act(notify);
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

  it('updates every pointer preview without React commits, including observer callbacks', () => {
    const notify = watchResize();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        return { width: Number.parseFloat(this.style.width) || 500 } as DOMRect;
      },
    );
    const commits = vi.fn();
    render(
      <Profiler id="split" onRender={commits}>
        <Split />
      </Profiler>,
    );
    const { divider, panel } = dividerAndPanel();
    const count = commits.mock.calls.length;
    Object.assign(divider, { setPointerCapture: vi.fn() });
    fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
    for (const clientX of [880, 860, 840]) {
      fireEvent.pointerMove(divider, { clientX });
      notify();
    }
    expect(panel.style.width).toBe('560px');
    expect(divider).toHaveAttribute('aria-valuenow', '560');
    expect(commits).toHaveBeenCalledTimes(count);
    expect(localStorage.getItem(widthKey)).toBeNull();
    fireEvent.pointerUp(divider);
    expect(localStorage.getItem(widthKey)).toBe('560');
    expect(commits.mock.calls.length).toBeGreaterThan(count);
  });

  it('restores automatic sizing and ARIA after cancelling a default-width drag', () => {
    render(<Split />);
    const { divider, panel } = dividerAndPanel();
    Object.assign(divider, { setPointerCapture: vi.fn() });
    fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
    fireEvent.pointerMove(divider, { clientX: 800 });
    fireEvent.pointerCancel(divider);
    expect(panel.style.width).toBe('');
    expect(panel.style.maxWidth).toBe('');
    expect(divider).toHaveAttribute('aria-valuenow', '500');
    expect(localStorage.getItem(widthKey)).toBeNull();
  });

  it('reclamps a live preview on container resize and ignores keyboard reset during the drag', () => {
    const notify = watchResize();
    render(<Split />);
    const { divider, panel } = dividerAndPanel();
    Object.assign(divider, { setPointerCapture: vi.fn() });
    fireEvent.pointerDown(divider, { button: 0, clientX: 900 });
    fireEvent.pointerMove(divider, { clientX: 0 });
    rowWidth = 760;
    notify();
    expect(panel.style.width).toBe('340px');
    expect(divider).toHaveAttribute('aria-valuemin', '304');
    expect(divider).toHaveAttribute('aria-valuemax', '340');
    expect(divider).toHaveAttribute('aria-valuenow', '340');
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(localStorage.getItem(widthKey)).toBeNull();
    fireEvent.keyDown(divider, { key: 'Enter' });
    fireEvent.doubleClick(divider);
    expect(panel.style.width).toBe('340px');
    fireEvent.pointerUp(divider);
    expect(localStorage.getItem(widthKey)).toBe('340');
  });
});
