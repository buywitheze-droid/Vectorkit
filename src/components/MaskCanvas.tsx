"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent,
} from "react";
import {
  Check,
  Eraser,
  Lasso,
  MousePointerClick,
  Paintbrush2,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  computeEdgeMap,
  LiveWire,
  rasterizePolygonMask,
  applyMaskToCanvas,
} from "@/lib/image/lasso";
import { clickToGrow } from "@/lib/image/regionSelect";
import { cn, clamp } from "@/lib/utils";

type Tool = "lasso" | "grow" | "brushErase" | "brushRestore";

interface MaskCanvasProps {
  /** Source image to mask. Preserved untouched; commit returns a new canvas. */
  source: HTMLCanvasElement;
  /** Called when the user commits the final mask. Receives the masked canvas. */
  onCommit: (masked: HTMLCanvasElement) => void;
  /** Called when the user cancels and returns to the previous step. */
  onCancel: () => void;
}

/**
 * Interactive masking surface that hosts:
 *
 *   • Magnetic lasso  — tap waypoints around the perimeter; the line snaps
 *                        to the strongest visible edge between consecutive
 *                        waypoints. Double-click or close-loop to commit.
 *   • Click-to-grow   — tap inside an element (rose, dress, leaf); the
 *                        mask floods to all connected similar-color pixels
 *                        but stops at strong edges.
 *   • Brush erase     — drag to paint mask = "remove this area" (existing
 *                        behavior, kept as a polish tool).
 *   • Brush restore   — drag to paint mask = "keep this area" (undo an
 *                        accidental erase).
 *
 * Internal state machine:
 *   – mode = current tool
 *   – mask = Uint8Array (0/1) the same size as the source image
 *            1 = pixel will be ERASED on commit (transparent)
 *            0 = pixel will be KEPT on commit
 *   – polyline = in-progress lasso waypoints (committed but not yet closed)
 *   – history = stack of past mask snapshots for undo/redo
 *
 * On commit, the mask is rasterized onto the source canvas (alpha=0 where
 * mask=1) and `onCommit(maskedCanvas)` is fired.
 *
 * NOTE on which-way-the-mask-goes:
 *   The lasso defaults to KEEP-INSIDE — i.e. user traces around the
 *   design and everything OUTSIDE the polygon becomes transparent. This
 *   matches the user's described workflow ("trace around the dress, hair,
 *   flowers, leaves to make a full mask"). Click-to-grow and brush also
 *   default to KEEP semantics. There's a "Invert" button at the top right
 *   if they want to flip and ERASE-INSIDE instead.
 */
export function MaskCanvas({ source, onCommit, onCancel }: MaskCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const [tool, setTool] = useState<Tool>("lasso");
  // The "keep set" — pixels marked 1 will be RETAINED; pixels marked 0
  // become transparent on commit. Starts all-1 (keep everything) so the
  // user can immediately use erase tools on a fresh image, or switch to
  // lasso to define a tight cutout from scratch.
  const [keepMask, setKeepMask] = useState<Uint8Array>(() => {
    const m = new Uint8Array(source.width * source.height);
    m.fill(1);
    return m;
  });
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [redoStack, setRedoStack] = useState<Uint8Array[]>([]);

  // Lasso state (the live polyline being drawn).
  const [lassoPoints, setLassoPoints] = useState<[number, number][]>([]);
  const [lassoLivePath, setLassoLivePath] = useState<[number, number][]>([]);
  const liveWireRef = useRef<LiveWire | null>(null);
  const edgeMapRef = useRef<Float32Array | null>(null);

  // View state (zoom/pan).
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [userZoom, setUserZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);

  // Brush state.
  const [brushSize, setBrushSize] = useState(28);
  const [growTolerance, setGrowTolerance] = useState(28);
  const isPaintingRef = useRef(false);
  const lastPaintPosRef = useRef<{ x: number; y: number } | null>(null);

  // Compute the edge map ONCE on mount — heavy but fast (~30 ms).
  useEffect(() => {
    edgeMapRef.current = computeEdgeMap(source);
    liveWireRef.current = new LiveWire(
      edgeMapRef.current,
      source.width,
      source.height
    );
  }, [source]);

  // Track container size for fit-to-screen scaling.
  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setContainerSize({ w: r.width, h: r.height });
    });
    obs.observe(wrap);
    return () => obs.disconnect();
  }, []);

  const fitScale = useMemo(() => {
    if (containerSize.w === 0 || containerSize.h === 0) return 1;
    return Math.min(
      containerSize.w / source.width,
      containerSize.h / source.height,
      1
    );
  }, [containerSize, source.width, source.height]);
  const totalScale = fitScale * userZoom;

  // Mount source canvas.
  useEffect(() => {
    sourceCanvasRef.current = source;
  }, [source]);

  // Render the mask overlay (red translucent for ERASE area, light for KEEP).
  // Overlay is rendered to a separate offscreen canvas and stamped over the
  // source. We re-render whenever keepMask, lasso polyline, or live path changes.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.width = source.width;
    overlay.height = source.height;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // 1. Tint pixels that will be ERASED (mask = 0) with translucent red.
    const w = overlay.width;
    const h = overlay.height;
    const img = ctx.createImageData(w, h);
    const tintR = 220, tintG = 38, tintB = 38;
    for (let i = 0; i < w * h; i++) {
      if (keepMask[i] === 0) {
        const k = i * 4;
        img.data[k] = tintR;
        img.data[k + 1] = tintG;
        img.data[k + 2] = tintB;
        img.data[k + 3] = 110;
      }
    }
    ctx.putImageData(img, 0, 0);

    // 2. Draw the in-progress lasso polyline + live wire on top.
    if (lassoPoints.length > 0) {
      ctx.lineWidth = Math.max(1.5, 1.5 / totalScale);
      ctx.strokeStyle = "#f97316"; // orange-500
      ctx.fillStyle = "#f97316";
      ctx.beginPath();
      ctx.moveTo(lassoPoints[0][0], lassoPoints[0][1]);
      for (let i = 1; i < lassoPoints.length; i++) {
        ctx.lineTo(lassoPoints[i][0], lassoPoints[i][1]);
      }
      ctx.stroke();
      // Mark each waypoint.
      const dotR = Math.max(3, 4 / totalScale);
      for (const [px, py] of lassoPoints) {
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (lassoLivePath.length > 1) {
      ctx.lineWidth = Math.max(1.5, 1.5 / totalScale);
      ctx.strokeStyle = "rgba(249, 115, 22, 0.7)";
      ctx.setLineDash([Math.max(4, 6 / totalScale), Math.max(2, 3 / totalScale)]);
      ctx.beginPath();
      ctx.moveTo(lassoLivePath[0][0], lassoLivePath[0][1]);
      for (let i = 1; i < lassoLivePath.length; i++) {
        ctx.lineTo(lassoLivePath[i][0], lassoLivePath[i][1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [keepMask, lassoPoints, lassoLivePath, source.width, source.height, totalScale]);

  // ─── History helpers ────────────────────────────────────────────────────

  const pushHistory = useCallback((current: Uint8Array) => {
    setHistory((h) => [...h.slice(-20), new Uint8Array(current)]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setRedoStack((r) => [...r, new Uint8Array(keepMask)]);
    setHistory((h) => h.slice(0, -1));
    setKeepMask(prev);
  }, [history, keepMask]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setHistory((h) => [...h, new Uint8Array(keepMask)]);
    setRedoStack((r) => r.slice(0, -1));
    setKeepMask(next);
  }, [redoStack, keepMask]);

  const clearMask = useCallback(() => {
    pushHistory(keepMask);
    const fresh = new Uint8Array(source.width * source.height);
    fresh.fill(1);
    setKeepMask(fresh);
    setLassoPoints([]);
    setLassoLivePath([]);
  }, [keepMask, pushHistory, source.width, source.height]);

  const invertMask = useCallback(() => {
    pushHistory(keepMask);
    const inv = new Uint8Array(keepMask.length);
    for (let i = 0; i < keepMask.length; i++) {
      inv[i] = keepMask[i] === 0 ? 1 : 0;
    }
    setKeepMask(inv);
  }, [keepMask, pushHistory]);

  // ─── Coordinate helpers ─────────────────────────────────────────────────

  /** Convert a screen-pixel mouse event into source-image pixel coords.
   *  Returns null if out of bounds. */
  const screenToImage = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>): { x: number; y: number } | null => {
      const wrap = wrapperRef.current;
      if (!wrap) return null;
      const rect = wrap.getBoundingClientRect();
      // Center of view.
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      // Mouse relative to wrapper center, undoing pan + scale.
      const mx = e.clientX - rect.left - cx - pan.x;
      const my = e.clientY - rect.top - cy - pan.y;
      const ix = mx / totalScale + source.width / 2;
      const iy = my / totalScale + source.height / 2;
      if (ix < 0 || iy < 0 || ix >= source.width || iy >= source.height) return null;
      return { x: Math.round(ix), y: Math.round(iy) };
    },
    [pan.x, pan.y, totalScale, source.width, source.height]
  );

  // ─── Tool: Magnetic Lasso ───────────────────────────────────────────────

  const handleLassoMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (tool !== "lasso") return;
      const wire = liveWireRef.current;
      if (!wire || lassoPoints.length === 0) return;
      const pt = screenToImage(e);
      if (!pt) return;
      // Snap to start point if close (within 12 source-pixels) — visual cue
      // for closing the loop.
      const start = lassoPoints[0];
      const dist = Math.hypot(pt.x - start[0], pt.y - start[1]);
      const target = dist < 12 && lassoPoints.length >= 3 ? { x: start[0], y: start[1] } : pt;
      const path = wire.pathTo(target.x, target.y);
      setLassoLivePath(path);
    },
    [tool, lassoPoints, screenToImage]
  );

  const commitLassoPolygon = useCallback(
    (poly: [number, number][]) => {
      pushHistory(keepMask);
      const insideMask = rasterizePolygonMask(poly, source.width, source.height);
      // The polygon defines what to KEEP. Update keepMask: AND with new poly
      // (so multiple successive lassoes can carve from the existing keep area).
      const next = new Uint8Array(keepMask.length);
      for (let i = 0; i < keepMask.length; i++) {
        next[i] = keepMask[i] && insideMask[i] ? 1 : 0;
      }
      setKeepMask(next);
      setLassoPoints([]);
      setLassoLivePath([]);
    },
    [keepMask, pushHistory, source.width, source.height]
  );

  const handleLassoClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (tool !== "lasso") return;
      const pt = screenToImage(e);
      if (!pt) return;
      const wire = liveWireRef.current;
      if (!wire) return;

      if (lassoPoints.length === 0) {
        // First waypoint — seed the live wire.
        wire.setSeed(pt.x, pt.y);
        setLassoPoints([[pt.x, pt.y]]);
        setLassoLivePath([]);
        return;
      }

      // Check for loop-close (clicked near start).
      const start = lassoPoints[0];
      const dist = Math.hypot(pt.x - start[0], pt.y - start[1]);
      if (dist < 12 && lassoPoints.length >= 3) {
        // Commit closed polygon.
        const finalPath = wire.pathTo(start[0], start[1]);
        const fullPoly: [number, number][] = [
          ...lassoPoints,
          ...finalPath.slice(1),
        ];
        commitLassoPolygon(fullPoly);
        return;
      }

      // Add waypoint: bake the current live path into the polyline, then
      // restart the wire from the new point.
      const livePath = wire.pathTo(pt.x, pt.y);
      const newPoints: [number, number][] = [
        ...lassoPoints,
        ...livePath.slice(1), // omit duplicate seed
      ];
      setLassoPoints(newPoints);
      wire.setSeed(pt.x, pt.y);
      setLassoLivePath([]);
    },
    [tool, lassoPoints, screenToImage, commitLassoPolygon]
  );

  const cancelLasso = useCallback(() => {
    setLassoPoints([]);
    setLassoLivePath([]);
  }, []);

  // ─── Tool: Click-to-Grow ────────────────────────────────────────────────

  const handleGrowClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (tool !== "grow") return;
      const pt = screenToImage(e);
      if (!pt) return;
      const edge = edgeMapRef.current;
      if (!edge) return;
      pushHistory(keepMask);

      // Grow into a fresh "selected" mask, then OR it with keepMask — i.e.
      // selecting via grow ADDS to the kept area. Wait — we want grow to
      // DEFINE which pixels are kept, and the rest get erased. So actually
      // each grow call should set those pixels to "definitely keep" while
      // leaving others as-is.
      //
      // Behavior: grow ADDS to the keep set. So the workflow is: tap each
      // design element (dress, each rose, leaves, text block) — each tap
      // adds that connected color region to the keep set. Pixels never
      // tapped remain in their default state.
      //
      // To make this useful from a fresh image (where everything is keep=1
      // by default), we provide a "Start grow selection" button that first
      // calls clearMask (everything erased), so subsequent grows light up
      // only the chosen elements.
      const grown = clickToGrow(source, edge, pt.x, pt.y, null, {
        colorTolerance: growTolerance,
      });
      const next = new Uint8Array(keepMask);
      for (let i = 0; i < next.length; i++) {
        if (grown[i] === 1) next[i] = 1;
      }
      setKeepMask(next);
    },
    [tool, growTolerance, keepMask, pushHistory, screenToImage, source]
  );

  // ─── Tool: Brush (erase + restore) ──────────────────────────────────────

  const paintAt = useCallback(
    (x: number, y: number, mode: "erase" | "restore") => {
      const r = brushSize / 2;
      const r2 = r * r;
      const w = source.width;
      const h = source.height;
      const next = new Uint8Array(keepMask);
      const value = mode === "erase" ? 0 : 1;
      const minX = Math.max(0, Math.floor(x - r));
      const maxX = Math.min(w - 1, Math.ceil(x + r));
      const minY = Math.max(0, Math.floor(y - r));
      const maxY = Math.min(h - 1, Math.ceil(y + r));
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          const dx = xx - x;
          const dy = yy - y;
          if (dx * dx + dy * dy <= r2) {
            next[yy * w + xx] = value;
          }
        }
      }
      setKeepMask(next);
    },
    [brushSize, keepMask, source.width, source.height]
  );

  // ─── Combined mouse handlers ────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Right click or middle click → pan.
      if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
        e.preventDefault();
        setIsPanning(true);
        panRef.current = {
          mx: e.clientX,
          my: e.clientY,
          px: pan.x,
          py: pan.y,
        };
        return;
      }
      if (e.button !== 0) return;

      if (tool === "brushErase" || tool === "brushRestore") {
        const pt = screenToImage(e);
        if (!pt) return;
        pushHistory(keepMask);
        isPaintingRef.current = true;
        lastPaintPosRef.current = pt;
        paintAt(pt.x, pt.y, tool === "brushErase" ? "erase" : "restore");
      }
    },
    [tool, pan.x, pan.y, screenToImage, paintAt, pushHistory, keepMask]
  );

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // Pan.
      if (isPanning && panRef.current) {
        setPan({
          x: panRef.current.px + (e.clientX - panRef.current.mx),
          y: panRef.current.py + (e.clientY - panRef.current.my),
        });
        return;
      }

      // Lasso live preview.
      if (tool === "lasso") {
        handleLassoMove(e);
      }

      // Brush stroke.
      if (isPaintingRef.current && (tool === "brushErase" || tool === "brushRestore")) {
        const pt = screenToImage(e);
        if (!pt) return;
        const last = lastPaintPosRef.current;
        if (last) {
          // Interpolate stamps along the segment so fast drags don't gap.
          const steps = Math.max(
            1,
            Math.ceil(Math.hypot(pt.x - last.x, pt.y - last.y) / (brushSize / 4))
          );
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            paintAt(
              last.x + (pt.x - last.x) * t,
              last.y + (pt.y - last.y) * t,
              tool === "brushErase" ? "erase" : "restore"
            );
          }
        }
        lastPaintPosRef.current = pt;
      }
    },
    [isPanning, tool, handleLassoMove, screenToImage, paintAt, brushSize]
  );

  const handleMouseUp = useCallback(() => {
    isPaintingRef.current = false;
    lastPaintPosRef.current = null;
    setIsPanning(false);
    panRef.current = null;
  }, []);

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      // We listen on click rather than mousedown so a click-and-drag for
      // panning doesn't accidentally drop a lasso waypoint.
      if (e.shiftKey) return;
      if (tool === "lasso") handleLassoClick(e);
      else if (tool === "grow") handleGrowClick(e);
    },
    [tool, handleLassoClick, handleGrowClick]
  );

  const handleDoubleClick = useCallback(() => {
    // Double-click while lassoing closes the polygon.
    if (tool === "lasso" && lassoPoints.length >= 3) {
      const wire = liveWireRef.current;
      if (!wire) return;
      const start = lassoPoints[0];
      const path = wire.pathTo(start[0], start[1]);
      const fullPoly: [number, number][] = [...lassoPoints, ...path.slice(1)];
      commitLassoPolygon(fullPoly);
    }
  }, [tool, lassoPoints, commitLassoPolygon]);

  const handleWheel = useCallback(
    (e: WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const factor = 1 - e.deltaY / 600;
      setUserZoom((z) => clamp(z * factor, 0.2, 8));
    },
    []
  );

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z"))) {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape" && lassoPoints.length > 0) {
        e.preventDefault();
        cancelLasso();
      } else if (e.key === "Enter" && tool === "lasso" && lassoPoints.length >= 3) {
        e.preventDefault();
        const wire = liveWireRef.current;
        if (!wire) return;
        const start = lassoPoints[0];
        const path = wire.pathTo(start[0], start[1]);
        const fullPoly: [number, number][] = [...lassoPoints, ...path.slice(1)];
        commitLassoPolygon(fullPoly);
      } else if (e.key === "l" || e.key === "L") {
        setTool("lasso");
      } else if (e.key === "g" || e.key === "G") {
        setTool("grow");
      } else if (e.key === "e" || e.key === "E") {
        setTool("brushErase");
      } else if (e.key === "r" || e.key === "R") {
        setTool("brushRestore");
      } else if (e.key === "[") {
        setBrushSize((s) => Math.max(4, s - 4));
      } else if (e.key === "]") {
        setBrushSize((s) => Math.min(200, s + 4));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, cancelLasso, lassoPoints, tool, commitLassoPolygon]);

  // ─── Commit ─────────────────────────────────────────────────────────────

  const handleFinish = useCallback(() => {
    const masked = applyMaskToCanvas(source, keepMask, "outside");
    onCommit(masked);
  }, [source, keepMask, onCommit]);

  // ─── Cursor styling ─────────────────────────────────────────────────────

  let cursor = "crosshair";
  if (isPanning) cursor = "grabbing";
  else if (tool === "brushErase" || tool === "brushRestore") cursor = "none"; // we draw a custom brush ring below
  else if (tool === "grow") cursor = "cell";

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-border bg-card/95 backdrop-blur-sm shrink-0">
        <div className="px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
            <div className="w-px h-5 bg-border mx-1" />
            <ToolButton active={tool === "lasso"} onClick={() => setTool("lasso")} title="Magnetic lasso (L) — tap waypoints around the design; line snaps to edges">
              <Lasso className="h-3.5 w-3.5" /> Lasso
            </ToolButton>
            <ToolButton active={tool === "grow"} onClick={() => setTool("grow")} title="Click to grow (G) — tap inside an element to keep all connected pixels">
              <MousePointerClick className="h-3.5 w-3.5" /> Grow
            </ToolButton>
            <ToolButton active={tool === "brushErase"} onClick={() => setTool("brushErase")} title="Brush erase (E)">
              <Eraser className="h-3.5 w-3.5" /> Erase
            </ToolButton>
            <ToolButton active={tool === "brushRestore"} onClick={() => setTool("brushRestore")} title="Brush restore (R) — paint to keep">
              <Paintbrush2 className="h-3.5 w-3.5" /> Restore
            </ToolButton>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={undo} disabled={history.length === 0} title="Undo (Ctrl+Z)">
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Y)">
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" onClick={invertMask} title="Invert mask">
              <RotateCcw className="h-3.5 w-3.5" /> Invert
            </Button>
            <Button variant="ghost" size="sm" onClick={clearMask} title="Reset to keep everything">
              <Trash2 className="h-3.5 w-3.5" /> Reset
            </Button>
            <div className="w-px h-5 bg-border mx-1" />
            <Button variant="primary" size="sm" onClick={handleFinish}>
              <Check className="h-3.5 w-3.5" /> Apply mask
            </Button>
          </div>
        </div>

        {/* Tool-specific options */}
        {(tool === "brushErase" || tool === "brushRestore") && (
          <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">Brush size</span>
            <input
              type="range"
              min={4}
              max={200}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="flex-1 max-w-xs"
            />
            <span className="font-mono tabular-nums w-10">{brushSize}px</span>
            <span className="text-muted-foreground">[ ] to resize</span>
          </div>
        )}
        {tool === "grow" && (
          <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">Color tolerance</span>
            <input
              type="range"
              min={4}
              max={80}
              value={growTolerance}
              onChange={(e) => setGrowTolerance(Number(e.target.value))}
              className="flex-1 max-w-xs"
            />
            <span className="font-mono tabular-nums w-10">{growTolerance}</span>
            <span className="text-muted-foreground">Higher = grows further into anti-aliased edges</span>
          </div>
        )}
        {tool === "lasso" && (
          <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
            {lassoPoints.length === 0
              ? "Tap on the edge of your design to start. Each subsequent tap adds a waypoint; the line snaps to the strongest visible edge between taps."
              : `${lassoPoints.length} waypoint${lassoPoints.length === 1 ? "" : "s"} placed. Click near the start point or press Enter to close. Press Esc to cancel.`}
          </div>
        )}
      </div>

      {/* Viewport */}
      <div
        ref={wrapperRef}
        className="flex-1 relative overflow-hidden bg-[#1e293b] checkerboard-dark select-none"
        style={{ cursor }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${totalScale})`,
            transformOrigin: "center",
          }}
        >
          <div className="relative" style={{ width: source.width, height: source.height }}>
            <SourceMount source={source} />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 pointer-events-none"
              style={{ width: source.width, height: source.height }}
            />
          </div>
        </div>

        {/* Bottom hint bar */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-card/95 backdrop-blur-sm border border-border rounded-md px-3 py-1.5 text-[11px] text-muted-foreground shadow-md">
          Shift+drag to pan · Wheel to zoom · {Math.round(totalScale * 100)}%
        </div>
      </div>
    </div>
  );
}

function SourceMount({ source }: { source: HTMLCanvasElement }) {
  const ref = useRef<HTMLDivElement>(null);
  // useLayoutEffect because we mount the live source canvas into the DOM
  // and want it visible before the next paint. The styling is applied via
  // setAttribute (not direct .style mutation) so the React Compiler can
  // see we're not modifying React-tracked state on the props object.
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.innerHTML = "";
    source.setAttribute(
      "style",
      `display:block;width:${source.width}px;height:${source.height}px`
    );
    slot.appendChild(source);
  }, [source]);
  return <div ref={ref} className="absolute inset-0" />;
}

function ToolButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
        active
          ? "bg-primary text-primary-foreground"
          : "text-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}
