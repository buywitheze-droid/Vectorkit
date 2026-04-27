"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Maximize,
  Minus,
  MousePointer2,
  Plus,
  Scan,
} from "lucide-react";
import { cn, clamp } from "@/lib/utils";
import { rgbToHex } from "@/lib/image/canvas";

export type BackgroundMode = "transparent" | "white" | "black" | "navy" | "red";

const BG_COLORS: Record<Exclude<BackgroundMode, "transparent">, string> = {
  white: "#ffffff",
  black: "#0a0a0a",
  navy: "#0a3d62",
  red: "#8b0000",
};

interface CanvasViewerProps {
  canvas: HTMLCanvasElement | null;
  background: BackgroundMode;
  pickMode: boolean;
  onPick?: (hex: string) => void;
  className?: string;
}

/**
 * Canvas viewer with mouse-wheel zoom, click-drag pan, eyedropper, and a
 * floating zoom toolbar. The source canvas is mounted directly into the DOM
 * and scaled with CSS transforms — fast, GPU-accelerated, and keeps memory
 * low even for huge images.
 */
export function CanvasViewer({
  canvas,
  background,
  pickMode,
  onPick,
  className,
}: CanvasViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [userZoom, setUserZoom] = useState(1); // 1 = fit-to-screen
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    mx: number;
    my: number;
    px: number;
    py: number;
    moved: boolean;
  } | null>(null);

  // Track container size with ResizeObserver.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setContainerSize({ w: r.width, h: r.height });
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  // Mount source canvas into slot. Re-mount whenever the canvas reference
  // changes (after any image processing operation).
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot || !canvas) return;
    slot.innerHTML = "";
    canvas.style.display = "block";
    canvas.style.maxWidth = "none";
    canvas.style.maxHeight = "none";
    slot.appendChild(canvas);
    return () => {
      // Don't remove canvas on unmount — it might still be referenced by React state.
    };
  }, [canvas]);

  // Compute fit scale: how much to scale the source so it fits the container at zoom=1.
  const fitScale =
    canvas && containerSize.w > 0 && containerSize.h > 0
      ? Math.min(
          containerSize.w / canvas.width,
          containerSize.h / canvas.height,
          1
        )
      : 1;
  const totalScale = fitScale * userZoom;

  // Reset pan when zoom returns to 1 (or below — no panning needed).
  useEffect(() => {
    if (userZoom <= 1) setPan({ x: 0, y: 0 });
  }, [userZoom]);

  // Reset zoom when canvas dimensions change drastically (e.g. after resize).
  // Keep zoom otherwise so fine-tuning multiple ops doesn't yank the view.
  const lastCanvasDimsRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!canvas) return;
    const last = lastCanvasDimsRef.current;
    const dims = { w: canvas.width, h: canvas.height };
    if (last) {
      const wRatio = Math.abs(dims.w - last.w) / last.w;
      const hRatio = Math.abs(dims.h - last.h) / last.h;
      if (wRatio > 0.2 || hRatio > 0.2) {
        setUserZoom(1);
        setPan({ x: 0, y: 0 });
      }
    }
    lastCanvasDimsRef.current = dims;
  }, [canvas]);

  // ─── Zoom / pan handlers ────────────────────────────────────────────────

  const setZoomAround = useCallback(
    (newZoom: number, anchor?: { x: number; y: number }) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) {
        setUserZoom(newZoom);
        return;
      }
      const clamped = clamp(newZoom, 0.1, 10);
      // Pan toward anchor: keep the point under cursor stable.
      if (anchor && userZoom > 0) {
        const rect = wrapper.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const ax = anchor.x - rect.left - cx; // anchor relative to center
        const ay = anchor.y - rect.top - cy;
        const ratio = clamped / userZoom;
        setPan((prev) => ({
          x: ax + (prev.x - ax) * ratio,
          y: ay + (prev.y - ay) * ratio,
        }));
      }
      setUserZoom(clamped);
    },
    [userZoom]
  );

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      if (!canvas) return;
      e.preventDefault();
      // Treat ctrl+wheel and pinch as zoom. Plain wheel also zooms (no scroll on canvas).
      const delta = -e.deltaY / 500;
      const factor = 1 + delta;
      setZoomAround(userZoom * factor, { x: e.clientX, y: e.clientY });
    },
    [canvas, userZoom, setZoomAround]
  );

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!canvas) return;
      // Left button only.
      if (e.button !== 0) return;
      // In pick mode, click-to-pick (no pan).
      if (pickMode) return;
      // Only allow pan when zoomed beyond fit.
      if (userZoom <= 1) return;
      e.preventDefault();
      setIsDragging(true);
      dragRef.current = {
        mx: e.clientX,
        my: e.clientY,
        px: pan.x,
        py: pan.y,
        moved: false,
      };
    },
    [canvas, pickMode, pan.x, pan.y, userZoom]
  );

  const handleMouseMove = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.mx;
    const dy = e.clientY - drag.my;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    setPan({ x: drag.px + dx, y: drag.py + dy });
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragRef.current = null;
  }, []);

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!pickMode || !canvas || !onPick) return;
      // Find the displayed canvas inside slot — it has the correct on-screen rect.
      const display = slotRef.current?.querySelector("canvas");
      if (!display) return;
      const rect = display.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const sx = Math.floor((x / rect.width) * canvas.width);
      const sy = Math.floor((y / rect.height) * canvas.height);
      if (sx < 0 || sx >= canvas.width || sy < 0 || sy >= canvas.height) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const data = ctx.getImageData(sx, sy, 1, 1).data;
      onPick(rgbToHex(data[0], data[1], data[2]));
    },
    [pickMode, canvas, onPick]
  );

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoomAround(userZoom * 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        setZoomAround(userZoom / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        setUserZoom(1);
        setPan({ x: 0, y: 0 });
      } else if (e.key === "1") {
        e.preventDefault();
        if (canvas) setZoomAround(1 / fitScale);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canvas, fitScale, userZoom, setZoomAround]);

  // ─── Cursor ──────────────────────────────────────────────────────────────

  let cursor = "default";
  if (pickMode) cursor = "crosshair";
  else if (userZoom > 1) cursor = isDragging ? "grabbing" : "grab";

  const wrapperBgStyle =
    background === "transparent"
      ? undefined
      : { backgroundColor: BG_COLORS[background] };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative w-full h-full overflow-hidden rounded-lg select-none",
        background === "transparent" && "checkerboard",
        className
      )}
      style={{ ...wrapperBgStyle, cursor }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
    >
      {canvas && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${totalScale})`,
            transformOrigin: "center",
            transition: isDragging ? "none" : "transform 100ms ease-out",
          }}
        >
          <div ref={slotRef} className="shadow-md" />
        </div>
      )}

      <ZoomToolbar
        zoom={userZoom}
        actualZoom={totalScale}
        onZoomIn={() => setZoomAround(userZoom * 1.25)}
        onZoomOut={() => setZoomAround(userZoom / 1.25)}
        onFit={() => {
          setUserZoom(1);
          setPan({ x: 0, y: 0 });
        }}
        onActualSize={() => canvas && setZoomAround(1 / fitScale)}
      />

      {pickMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-medium px-3 py-1.5 rounded-full shadow-lg flex items-center gap-2 animate-fade-in pointer-events-none">
          <MousePointer2 className="h-3.5 w-3.5" />
          Click anywhere on the image to pick a color
        </div>
      )}
    </div>
  );
}

function ZoomToolbar({
  zoom,
  actualZoom,
  onZoomIn,
  onZoomOut,
  onFit,
  onActualSize,
}: {
  zoom: number;
  actualZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onActualSize: () => void;
}) {
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-card/95 backdrop-blur-sm border border-border rounded-lg shadow-md p-1 select-none">
      <ToolbarButton onClick={onZoomOut} title="Zoom out (-)">
        <Minus className="h-4 w-4" />
      </ToolbarButton>
      <button
        onClick={onFit}
        className="px-2 py-1 text-xs font-mono tabular-nums hover:bg-muted rounded cursor-pointer min-w-[52px] text-center"
        title="Fit to screen (0)"
      >
        {Math.round(actualZoom * 100)}%
      </button>
      <ToolbarButton onClick={onZoomIn} title="Zoom in (+)">
        <Plus className="h-4 w-4" />
      </ToolbarButton>
      <div className="w-px h-5 bg-border mx-1" />
      <ToolbarButton onClick={onFit} title="Fit to screen (0)">
        <Maximize className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton onClick={onActualSize} title="Actual size 100% (1)">
        <Scan className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-muted text-foreground cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}
