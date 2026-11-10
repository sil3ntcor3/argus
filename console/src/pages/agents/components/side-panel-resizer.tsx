import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

const WIDTH_KEY = 'agent-side-panel-width';
const CHAT_MIN = 420;
const PANEL_MIN = 360;
const KEY_STEP = 24;

function readWidth(): number | null {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

function widthLimits(rowWidth: number) {
  const max = Math.max(0, rowWidth - CHAT_MIN);
  const min = Math.min(PANEL_MIN, Math.floor(rowWidth * 0.4), max);
  return { min, max };
}

function clampWidth(width: number, rowWidth: number) {
  const { min, max } = widthLimits(rowWidth);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Desktop split with a local width preference and a keyboard-operable divider. */
export function ResizableSidePanel({
  rowRef,
  children,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const id = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [preferred, setPreferred] = useState(readWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const [size, setSize] = useState({ row: 0, panel: 0 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    width: number;
    last: number | null;
  } | null>(null);

  useEffect(() => {
    const row = rowRef.current;
    const panel = panelRef.current;
    if (!row || !panel) return;
    const measure = () => {
      const next = {
        row: row.clientWidth,
        panel: Math.round(panel.getBoundingClientRect().width),
      };
      if (next.panel === 0) return;
      setSize((previous) =>
        previous.row === next.row && previous.panel === next.panel
          ? previous
          : next,
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [rowRef]);

  const desired = preview ?? preferred;
  const width =
    size.row && desired !== null ? clampWidth(desired, size.row) : undefined;
  const { min, max } = widthLimits(size.row);

  function commitWidth(next: number | null) {
    setPreferred(next);
    try {
      if (next === null) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Keep the width for this page when storage is unavailable.
    }
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    const width = panelRef.current?.getBoundingClientRect().width;
    if (event.button !== 0 || drag.current || !width) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width,
      last: null,
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    const total = rowRef.current?.clientWidth;
    if (!current || current.pointerId !== event.pointerId || !total) return;
    current.last = clampWidth(current.width + current.x - event.clientX, total);
    setPreview(current.last);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
    if (
      commit &&
      current.last !== null &&
      current.last !== Math.round(current.width)
    ) {
      commitWidth(current.last);
    }
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitWidth(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const current = panelRef.current?.getBoundingClientRect().width;
    const total = rowRef.current?.clientWidth;
    if (!current || !total) return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP;
    const next = clampWidth(current + delta, total);
    if (next !== Math.round(current)) commitWidth(next);
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panel"
        aria-controls={id}
        aria-valuemin={size.row ? min : undefined}
        aria-valuemax={size.row ? max : undefined}
        aria-valuenow={width ?? (size.row ? size.panel : undefined)}
        tabIndex={0}
        title="Resize with the arrow keys or drag. Press Enter or double-click to reset."
        className="group relative z-10 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none outline-none lg:block"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onLostPointerCapture={(event) => endDrag(event, false)}
        onKeyDown={handleKey}
        onDoubleClick={() => commitWidth(null)}
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:w-0.5 group-hover:bg-primary/60 group-focus-visible:w-0.5 group-focus-visible:bg-primary" />
      </div>
      <aside
        id={id}
        ref={panelRef}
        style={width === undefined ? undefined : { width, maxWidth: 'none' }}
        className="hidden w-2/5 shrink-0 flex-col duration-300 animate-in fade-in-0 slide-in-from-right-4 lg:flex xl:w-1/2 2xl:max-w-3xl"
      >
        {children}
      </aside>
    </>
  );
}
