/**
 * Print-render pipeline.
 *
 * Single entry point that takes a transparent-BG cutout + print-target
 * settings and returns a final canvas ready to download.
 *
 *   source canvas (any size)
 *        │
 *        ├──→ Lanczos-3 resize to target dimensions  ─────────┐
 *        │                                                     │
 *        └──→ detectTextColours → vectorizeColour (each one)   │
 *                                            │                 │
 *                                            └──→ composeVectorOverlays
 *                                                              │
 *                                                              ▼
 *                                                       edge-aware sharpen (optional)
 *                                                              │
 *                                                              ▼
 *                                                          final PNG
 *
 * Why it's split this way:
 *   • Lanczos handles the bulk (decorative pixels, soft florals, dress).
 *   • Vector text REPLACES the small-but-critical text pixels with
 *     resolution-independent paths — the visible-quality win.
 *   • Sharpen at the end gives a final pop on edges that survived as
 *     raster (frame strokes, fine filigree).
 */

import { resample } from "./resample";
import { edgeAwareSharpen } from "./sharpen";
import {
  composeVectorOverlays,
  detectTextColours,
  vectorizeColour,
  type DetectedTextColour,
  type VectorizedColourResult,
} from "./textVectorize";

export interface PrintRenderOptions {
  /** Target output width in pixels. */
  targetWidth: number;
  /** Target output height in pixels. */
  targetHeight: number;
  /** Run text vectorisation? Default true. The big quality win for upscales. */
  vectorizeText?: boolean;
  /** Maximum number of distinct text colours to vectorise. Default 3 —
   *  most invitations have 1–2 text colours; 3 is a safety margin. */
  maxTextColours?: number;
  /** Run edge-aware unsharp mask after compositing? Default true. */
  sharpen?: boolean;
  /** Sharpening intensity 0–1. Default 0.4 — punchy without ringing. */
  sharpenAmount?: number;
  /** Source canvas to use for TEXT DETECTION & TRACING. Defaults to
   *  `source` if omitted.
   *
   *  Why this exists: when the design went through chromakey BG removal,
   *  the cutout's text edges may have been eaten (especially for text
   *  colours close to the BG colour, e.g. light gold on white). Tracing
   *  from the cutout would bake in that damage. Passing the PRISTINE
   *  upload here lets us trace from the unmolested text shape.
   *
   *  The cutout's alpha channel still gates the composite — anything you
   *  manually erased (lasso/brush) won't be resurrected. We only "reach
   *  back into" the trace source for small (≤ 4 px) BG-removal damage
   *  immediately adjacent to surviving text. */
  traceSource?: HTMLCanvasElement;
  /** Optional progress callback. */
  onProgress?: (stage: string, pct: number) => void;
}

export interface PrintRenderResult {
  canvas: HTMLCanvasElement;
  /** Which colours were vectorised (for the UI to show "we vectorised
   *  these N colours"). Empty if vectorizeText was off or nothing found. */
  vectorizedColours: DetectedTextColour[];
}

/**
 * The full pipeline. Async because vectorisation lazy-imports potrace-plus.
 *
 *   const out = await renderForPrint(cutout, {
 *     targetWidth: 1500, targetHeight: 2100,
 *     vectorizeText: true, sharpen: true,
 *   });
 *   downloadCanvas(out.canvas);
 */
export async function renderForPrint(
  source: HTMLCanvasElement,
  opts: PrintRenderOptions
): Promise<PrintRenderResult> {
  const {
    targetWidth: tw,
    targetHeight: th,
    vectorizeText = true,
    maxTextColours = 3,
    sharpen = true,
    sharpenAmount = 0.4,
    traceSource,
    onProgress,
  } = opts;
  // Trace from the pristine upload if provided, else fall back to the
  // (possibly-BG-removed) cutout. See PrintRenderOptions.traceSource for
  // the rationale.
  const traceFrom = traceSource ?? source;

  // ── Stage 1: Lanczos resample to target ────────────────────────────────
  onProgress?.("Resampling", 0);
  let result = resample(source, tw, th, "lanczos3");
  onProgress?.("Resampling", 35);

  // ── Stage 2: Vectorise text (optional) ─────────────────────────────────
  const vectorizedColours: DetectedTextColour[] = [];
  if (vectorizeText) {
    onProgress?.("Detecting text", 40);
    // The detector already filters and orders by text-likelihood. We
    // take its results as-is — no further filtering needed.
    const real = detectTextColours(traceFrom, maxTextColours);

    if (real.length > 0) {
      onProgress?.("Tracing letterforms", 50);
      const overlays: VectorizedColourResult[] = [];
      for (let i = 0; i < real.length; i++) {
        try {
          const layer = await vectorizeColour(traceFrom, real[i], {
            targetWidth: tw,
            targetHeight: th,
          });
          overlays.push(layer);
          vectorizedColours.push(real[i]);
        } catch (e) {
          console.warn(
            `Vectorisation failed for colour ${real[i].hex}:`,
            e
          );
        }
        onProgress?.("Tracing letterforms", 50 + (30 * (i + 1)) / real.length);
      }
      if (overlays.length > 0) {
        onProgress?.("Compositing", 80);
        result = composeVectorOverlays(result, traceFrom, overlays, {
          // Dilation in source-pixel units. 2 px catches the AA halo
          // around each letter without grabbing adjacent design colour.
          dilatePx: 2,
          // Reach in target pixels — the vector overlay can extend up
          // to this far past an opaque base pixel. Bridges BG-removal
          // damage (1–3 px erosion of text edges) without resurrecting
          // larger user-erased regions.
          reachDilatePx: 4,
        });
      }
    }
  }

  // ── Stage 3: Edge-aware sharpen ────────────────────────────────────────
  if (sharpen && sharpenAmount > 0) {
    onProgress?.("Sharpening", 90);
    result = edgeAwareSharpen(result, {
      amount: sharpenAmount,
      radius: 1.2,
      edgeThreshold: 0.08,
    });
  }

  onProgress?.("Done", 100);
  return { canvas: result, vectorizedColours };
}

// ─── Print-size helpers ─────────────────────────────────────────────────

export interface PrintSize {
  /** Display name shown in the UI dropdown. */
  label: string;
  /** Width in inches. */
  widthIn: number;
  /** Height in inches. */
  heightIn: number;
}

/** The acrylic-invite sizes most shops offer. */
export const COMMON_PRINT_SIZES: PrintSize[] = [
  { label: "4 × 6 in (acrylic mini)", widthIn: 4, heightIn: 6 },
  { label: "5 × 7 in (acrylic standard)", widthIn: 5, heightIn: 7 },
  { label: "6 × 9 in (acrylic large)", widthIn: 6, heightIn: 9 },
  { label: "8 × 10 in (acrylic XL)", widthIn: 8, heightIn: 10 },
  { label: "Source size (no resize)", widthIn: 0, heightIn: 0 },
];

/** Convert a print size + DPI to pixel dimensions, preserving the source
 *  aspect ratio if the print size's aspect doesn't match exactly. */
export function pixelDimsFor(
  source: HTMLCanvasElement,
  print: PrintSize,
  dpi: number
): { width: number; height: number } {
  if (print.widthIn === 0 || print.heightIn === 0) {
    return { width: source.width, height: source.height };
  }
  // Fit the source into the print rectangle preserving aspect.
  const printAspect = print.widthIn / print.heightIn;
  const srcAspect = source.width / source.height;
  let w: number, h: number;
  if (srcAspect >= printAspect) {
    // Source is wider — width-bound.
    w = Math.round(print.widthIn * dpi);
    h = Math.round(w / srcAspect);
  } else {
    h = Math.round(print.heightIn * dpi);
    w = Math.round(h * srcAspect);
  }
  return { width: w, height: h };
}

/** Effective DPI of the source given a target print size — useful as a
 *  warning indicator when the user picks a print size larger than the
 *  source can support without upscaling. */
export function effectiveSourceDpi(
  source: HTMLCanvasElement,
  print: PrintSize
): number | null {
  if (print.widthIn === 0 || print.heightIn === 0) return null;
  const printAspect = print.widthIn / print.heightIn;
  const srcAspect = source.width / source.height;
  if (srcAspect >= printAspect) return source.width / print.widthIn;
  return source.height / print.heightIn;
}
