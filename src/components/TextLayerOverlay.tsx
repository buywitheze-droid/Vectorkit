"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { getFont } from "@/lib/fonts/registry";
import type { TextLayer } from "@/lib/image/textLayer";
import { cn } from "@/lib/utils";

interface TextLayerOverlayProps {
  layers: TextLayer[];
  /** Currently-selected layer id (or null). Selected layer gets the
   *  drag handle ring. */
  selectedId: string | null;
  /** True when the overlay is interactive. When false, layers render
   *  but don't accept clicks/drags — used in Step 4 preview. */
  interactive: boolean;
  onSelect?: (id: string | null) => void;
  /** Move-by-delta in source-canvas pixels. Called on every drag tick
   *  so the parent can render the move live. */
  onMove?: (id: string, dx: number, dy: number) => void;
  /** Double-click → enter inline edit mode. */
  onEdit?: (id: string) => void;
  /** Reserved for explicit scale override. Unused in v1: the drag
   *  handler measures the actual on-screen scale via getBoundingClientRect
   *  at drag-start, which transparently handles fit-scale × user-zoom. */
  scale?: number;
}

/**
 * Renders text layers as positioned HTML divs, sitting in the same
 * coordinate space as the underlying canvas.
 *
 * Mounted INSIDE the same transformed wrapper that hosts the canvas
 * (see CanvasViewer's transform container) so it inherits the same pan
 * and zoom — no separate transform math needed in this component.
 *
 * Rendering as HTML (instead of in canvas) gives us:
 *   • Crisp text at any zoom — the browser anti-aliases via the OS
 *     font renderer, not raster scaling.
 *   • Native drag-to-move with mouse handlers, no canvas hit-testing.
 *   • Free a11y / selection / inspect-element for debugging.
 *
 * The print pipeline handles canvas-side rendering separately via
 * `renderTextLayers` in lib/image/textRender.ts — same model, same
 * font family, identical visual result.
 */
export function TextLayerOverlay({
  layers,
  selectedId,
  interactive,
  onSelect,
  onMove,
  onEdit,
}: TextLayerOverlayProps) {
  return (
    <div
      className="absolute inset-0"
      // When interactive, the wrapper has to capture clicks on EMPTY
      // space too (so clicking outside a layer deselects). When not
      // interactive, pass clicks through to whatever's underneath.
      style={{ pointerEvents: interactive ? "auto" : "none" }}
      onMouseDown={(e) => {
        // Click on the wrapper (not on a layer) → deselect.
        if (interactive && e.target === e.currentTarget) {
          onSelect?.(null);
        }
      }}
    >
      {layers.map((layer) => (
        <DraggableLayer
          key={layer.id}
          layer={layer}
          selected={layer.id === selectedId}
          interactive={interactive}
          onSelect={() => onSelect?.(layer.id)}
          onMove={(dx, dy) => onMove?.(layer.id, dx, dy)}
          onEdit={() => onEdit?.(layer.id)}
        />
      ))}
    </div>
  );
}

function DraggableLayer({
  layer,
  selected,
  interactive,
  onSelect,
  onMove,
  onEdit,
}: {
  layer: TextLayer;
  selected: boolean;
  interactive: boolean;
  onSelect: () => void;
  onMove: (dx: number, dy: number) => void;
  onEdit: () => void;
}) {
  const font = getFont(layer.fontId);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    mx: number;
    my: number;
    moved: boolean;
    /** Actual screen-pixels-per-source-pixel ratio captured at
     *  drag-start. Computed from the rendered DOM rect of the
     *  parent canvas wrapper, which has the CanvasViewer's
     *  fit-scale × user-zoom transform already applied. This is the
     *  ONLY place we need to know the real on-screen scale — and we
     *  do it without prop drilling by measuring the DOM. */
    scale: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!interactive) return;
      e.stopPropagation();
      e.preventDefault();
      onSelect();
      // Compute the on-screen scale by measuring the parent overlay
      // container's bounding rect vs its CSS width. Both are in
      // source-canvas units, so their ratio is the screen-px-per-
      // source-px factor we need for drag math.
      let scale = 1;
      const inner = innerRef.current;
      if (inner) {
        // Walk up to the canvas-sized wrapper (CanvasViewer mounts
        // overlay inside a div whose CSS width = canvas.width source
        // pixels). offsetParent works for our flat layout.
        let parent: HTMLElement | null = inner.parentElement;
        while (parent && parent.style.position !== "absolute") {
          parent = parent.parentElement;
        }
        const wrap = parent?.parentElement; // canvas-sized wrapper
        if (wrap) {
          const rect = wrap.getBoundingClientRect();
          const cssW = wrap.offsetWidth;
          if (cssW > 0) scale = rect.width / cssW;
        }
      }
      dragRef.current = { mx: e.clientX, my: e.clientY, moved: false, scale };
      setIsDragging(true);

      const handleMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = (ev.clientX - drag.mx) / drag.scale;
        const dy = (ev.clientY - drag.my) / drag.scale;
        if (Math.abs(ev.clientX - drag.mx) > 2 || Math.abs(ev.clientY - drag.my) > 2) {
          drag.moved = true;
        }
        // Reset baseline so we report deltas, not totals.
        drag.mx = ev.clientX;
        drag.my = ev.clientY;
        onMove(dx, dy);
      };
      const handleUp = () => {
        dragRef.current = null;
        setIsDragging(false);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [interactive, onSelect, onMove]
  );

  // Position is anchor (x,y). Translate the div to that anchor, then
  // use textAlign + transform to honour `align` and rotation around
  // the anchor. We use the inner span for the actual text and let
  // CSS handle the align math via translateX percentages.
  const alignTranslate =
    layer.align === "left" ? "0%" : layer.align === "right" ? "-100%" : "-50%";

  if (!font) return null;

  // Outer wrapper sits at the anchor in source-canvas coords, scaled
  // by the viewport. We DON'T apply rotation here — rotation is on the
  // inner span so the selection ring follows the rotated text.
  const outerStyle: CSSProperties = {
    position: "absolute",
    left: layer.x,
    top: layer.y,
    width: 0,
    height: 0,
    pointerEvents: "none",
  };

  // Inner: the actual text. Sized in source-canvas pixels (parent
  // transform handles the scale to screen). textAlign + translateX
  // gives us free alignment around the anchor without measuring.
  const innerStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    transform: `translate(${alignTranslate}, -100%) rotate(${layer.rotation}rad)`,
    transformOrigin: layer.align === "left" ? "0% 100%" : layer.align === "right" ? "100% 100%" : "50% 100%",
    fontFamily: font.family,
    fontSize: layer.size,
    fontWeight: layer.weight,
    fontStyle: layer.italic ? "italic" : "normal",
    color: layer.color,
    letterSpacing: layer.letterSpacing ? `${layer.letterSpacing}px` : "normal",
    whiteSpace: "nowrap",
    lineHeight: 1,
    pointerEvents: interactive ? "auto" : "none",
    cursor: interactive ? (isDragging ? "grabbing" : "grab") : "default",
    userSelect: "none",
    // Use a thin outline ring for the selected layer so the user can
    // see exactly what's being edited without obscuring the glyphs.
    outline: selected ? "2px dashed rgba(99, 102, 241, 0.85)" : "none",
    outlineOffset: "4px",
  };

  return (
    <div style={outerStyle}>
      <div
        ref={innerRef}
        style={innerStyle}
        className={cn(selected && "z-10")}
        onMouseDown={handleDown}
        onDoubleClick={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          onEdit();
        }}
        title={interactive ? "Drag to move · double-click to edit" : undefined}
      >
        {layer.text || (interactive ? <span style={{ opacity: 0.5 }}>(empty)</span> : "")}
      </div>
    </div>
  );
}
