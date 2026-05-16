/**
 * Text-region vectorisation for print sharpening.
 *
 * Problem: invitation designs arrive as 1080-px screenshots. When the user
 * prints at 5×7" or larger (1500–2400 px @ 300 DPI), the script-style
 * letterforms — usually 1–3 px wide at source — get visibly chunky no
 * matter how good the resampling filter is. Text, more than any other
 * element, suffers from this.
 *
 * Solution: detect the solid-coloured text regions, trace them into smooth
 * vector paths (potrace algorithm), and re-rasterise the paths at the
 * TARGET print resolution. Text becomes infinitely sharp because it's no
 * longer pixels — it's curves.
 *
 *   source pixels (1080w)  ──Lanczos─→  base raster (target)
 *           │
 *           └──→  per-text-colour binary mask  ──potrace─→  SVG paths
 *                                                              │
 *                                                              └──→  re-rasterise at target → composite over base
 *
 * Detection heuristics (no machine learning):
 *   • Find the top-N most-frequent solid colours in the cutout (excluding
 *     transparent BG and noisy AA bins).
 *   • Each candidate colour is "text-like" if its connected components
 *     are mostly small (letters / words) and don't cover more than ~10 %
 *     of the cutout area (rules out big decorative elements).
 *   • Per-colour total pixel count must be > 0.05 % of cutout (filters
 *     out incidental colour blobs).
 *
 * Composition:
 *   • At target resolution, the vector-rendered text REPLACES the pixels
 *     that were the same colour in the source (within tolerance + AA dilation).
 *   • Non-text pixels stay as the Lanczos base.
 */

import { canvasToImageData, imageDataToCanvas } from "./canvas";

export interface DetectedTextColour {
  /** Hex string e.g. "#1a3354". */
  hex: string;
  /** RGB. */
  r: number;
  g: number;
  b: number;
  /** Number of opaque source pixels matching this colour within tolerance. */
  pixels: number;
  /** Number of connected components in the colour's binary mask. */
  components: number;
  /** Median bounding-box height of the components. Texts have small heights;
   *  decorative elements have huge heights. */
  medianComponentHeight: number;
  /** Mean pixel-count per component. Real letters have high density (50–500
   *  px each at 1080-wide source); AA fringe noise is single digits. */
  meanComponentPixels: number;
}

/**
 * Find candidate text colours in a transparent-BG cutout. Returns up to
 * `maxColours` distinct colours sorted by likelihood that they're text.
 *
 * "Likelihood" weights small-component count (lots of small letters) and
 * penalises huge-component count (a single big shape isn't text).
 */
export function detectTextColours(
  source: HTMLCanvasElement,
  maxColours = 3
): DetectedTextColour[] {
  const img = canvasToImageData(source);
  const w = img.width;
  const h = img.height;
  const data = img.data;

  // 1. Histogram opaque pixels into 5-bit-per-channel buckets (32³).
  //    Skip near-greyscale super-light pixels (R,G,B all > 230 with low
  //    saturation): these are anti-alias fringe halos around dark design
  //    elements, NOT real text colours, and they always dominate the
  //    histogram for any design with detail on a light background.
  const NB = 32;
  const buckets = new Uint32Array(NB * NB * NB);
  let opaqueCount = 0;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    if (data[k + 3] < 128) continue;
    const r = data[k];
    const g = data[k + 1];
    const b = data[k + 2];
    if (isAaFringeColour(r, g, b)) continue;
    buckets[((r >> 3) * NB + (g >> 3)) * NB + (b >> 3)]++;
    opaqueCount++;
  }
  if (opaqueCount === 0) return [];

  // 2. Top-K bucket sweep — collect populous bins, skipping ones too
  // close to a previously-picked bin (so we don't get 3 near-identical
  // shades of the same gold).
  const minPixels = Math.max(80, Math.floor(opaqueCount * 0.003));
  const candidates: { rb: number; gb: number; bb: number; n: number }[] = [];
  for (let rb = 0; rb < NB; rb++) {
    for (let gb = 0; gb < NB; gb++) {
      for (let bb = 0; bb < NB; bb++) {
        const n = buckets[(rb * NB + gb) * NB + bb];
        if (n >= minPixels) candidates.push({ rb, gb, bb, n });
      }
    }
  }
  candidates.sort((a, b) => b.n - a.n);

  // Drop the single most-populous bin if it's > 40 % of opaque pixels —
  // that's the dominant background or main-fill colour, never text.
  if (
    candidates.length > 1 &&
    candidates[0].n > opaqueCount * 0.4
  ) {
    candidates.shift();
  }

  const TOP = Math.min(60, candidates.length);
  const picked: { rb: number; gb: number; bb: number; n: number }[] = [];
  for (let i = 0; i < TOP && picked.length < maxColours * 6; i++) {
    const c = candidates[i];
    let tooClose = false;
    for (const p of picked) {
      const dr = (c.rb - p.rb) * 8;
      const dg = (c.gb - p.gb) * 8;
      const db = (c.bb - p.bb) * 8;
      if (dr * dr + dg * dg + db * db < 28 * 28) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) picked.push(c);
  }

  // 3. For each picked colour, refine the centroid by averaging all
  // matching opaque pixels, then run a connected-components pass to
  // compute text-likelihood metrics.
  const refined: DetectedTextColour[] = [];
  const tol = 20;
  for (const p of picked) {
    const cR = p.rb * 8 + 4;
    const cG = p.gb * 8 + 4;
    const cB = p.bb * 8 + 4;
    let sumR = 0, sumG = 0, sumB = 0, n = 0;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const k = i * 4;
      if (data[k + 3] < 128) continue;
      const dr = data[k] - cR;
      const dg = data[k + 1] - cG;
      const db = data[k + 2] - cB;
      if (dr * dr + dg * dg + db * db <= tol * tol) {
        sumR += data[k];
        sumG += data[k + 1];
        sumB += data[k + 2];
        n++;
        mask[i] = 1;
      }
    }
    if (n < minPixels) continue;
    const refinedR = Math.round(sumR / n);
    const refinedG = Math.round(sumG / n);
    const refinedB = Math.round(sumB / n);
    // A second AA-fringe check on the refined centroid: in case the
    // bucket centroid was non-fringe but the actual cluster mean drifts
    // toward fringe.
    if (isAaFringeColour(refinedR, refinedG, refinedB)) continue;
    const heights = componentBoundingBoxHeights(mask, w, h);
    if (heights.length === 0) continue;
    heights.sort((a, b) => a - b);
    const medianH = heights[heights.length >> 1];
    const meanPx = n / heights.length;
    refined.push({
      hex: rgbToHex(refinedR, refinedG, refinedB),
      r: refinedR,
      g: refinedG,
      b: refinedB,
      pixels: n,
      components: heights.length,
      medianComponentHeight: medianH,
      meanComponentPixels: meanPx,
    });
  }

  // 4. Filter to "looks like text" candidates only. Real text:
  //   • mean pixels per component ≥ 25 (filters out single-pixel speckle
  //     noise from AA fringes that survived isAaFringeColour)
  //   • median component height between 6 and (image-height × 0.2)
  //     (excludes both single-pixel noise and full-image-spanning shapes)
  //   • component count ≥ 8 (a real text block has at least a word's
  //     worth of letters, including separated dots/strokes)
  //   • total pixel coverage ≤ 30 % of opaque area (the colour isn't
  //     the fill of a huge decorative element)
  const heightCap = h * 0.2;
  const realText = refined.filter(
    (c) =>
      c.meanComponentPixels >= 25 &&
      c.medianComponentHeight >= 6 &&
      c.medianComponentHeight <= heightCap &&
      c.components >= 8 &&
      c.pixels <= opaqueCount * 0.3
  );

  // 5. Score & sort. We weight by component count (more letters = more
  // text-like) and BOOST saturated/dark colours (real ink colours; AA
  // remnants tend to be desaturated mid-greys).
  const score = (c: DetectedTextColour) => {
    const sat = colourSaturation(c.r, c.g, c.b);
    const darkness = 1 - (c.r + c.g + c.b) / (3 * 255);
    const inkBoost = 1 + sat * 1.5 + Math.max(0, darkness - 0.3) * 1.2;
    return c.components * inkBoost;
  };
  realText.sort((a, b) => score(b) - score(a));
  return realText.slice(0, maxColours);
}

/**
 * Recognise pixels that are anti-alias fringe halos rather than real
 * text. Heuristic: very light AND near-greyscale. Real text colours are
 * either saturated (gold, navy, teal) or sufficiently dark (near-black
 * body copy). White/cream/beige body copy on light backgrounds is rare
 * in invitation designs (and when it does happen, the text is usually
 * outlined in a darker colour we'll catch instead).
 */
function isAaFringeColour(r: number, g: number, b: number): boolean {
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const sat = colourSaturation(r, g, b);
  // Very light + low saturation = halo around dark element on white BG.
  if (maxC > 230 && maxC - minC < 20 && sat < 0.08) return true;
  // Mid-grey range with low saturation = generic anti-alias residue.
  if (maxC > 180 && maxC < 230 && maxC - minC < 12 && sat < 0.06) return true;
  return false;
}

function colourSaturation(r: number, g: number, b: number): number {
  const maxC = Math.max(r, g, b);
  if (maxC === 0) return 0;
  const minC = Math.min(r, g, b);
  return (maxC - minC) / maxC;
}

// ─── Vectorise + render ──────────────────────────────────────────────────

export interface VectorizeOptions {
  /** Target output dimensions (the canvas the vector text will be rendered
   *  into). Required because vectorisation only pays off at the target res. */
  targetWidth: number;
  targetHeight: number;
  /** RGB tolerance for "this pixel is the text colour". Default 18. */
  colorTolerance?: number;
  /** Speckle suppression — components smaller than this are ignored.
   *  Default 2 px (potrace-plus default). */
  turdSize?: number;
}

export interface VectorizedColourResult {
  hex: string;
  /** Canvas the same size as the target, with the rendered vector text
   *  in the colour, transparent everywhere else. Composite this on top
   *  of the Lanczos-resized base at full opacity. */
  canvas: HTMLCanvasElement;
  /** Pixel coverage in the source (used by the composite step to know
   *  WHERE to apply this overlay). Same size as the SOURCE canvas,
   *  1 = was-this-colour, 0 = was-not. */
  sourceMask: Uint8Array;
}

/**
 * Run potrace on the binary mask of `colour` from `source`, then render
 * the resulting vector paths into a target-sized canvas. Returns a layer
 * the caller composites over the Lanczos base.
 *
 * Loads `potrace-plus` via dynamic import — adds ~30 KB to the bundle but
 * only on first use of text vectorisation. Subsequent calls reuse the
 * loaded module.
 */
export async function vectorizeColour(
  source: HTMLCanvasElement,
  colour: DetectedTextColour,
  opts: VectorizeOptions
): Promise<VectorizedColourResult> {
  const tol = opts.colorTolerance ?? 18;
  const sw = source.width;
  const sh = source.height;
  const tw = opts.targetWidth;
  const th = opts.targetHeight;

  // 1. Build binary mask of the source — black on white background (potrace
  // traces black-on-white). Also build the `sourceMask` Uint8Array used
  // by the composite step.
  const srcImg = canvasToImageData(source);
  const data = srcImg.data;
  const sourceMask = new Uint8Array(sw * sh);
  const binCanvas = document.createElement("canvas");
  binCanvas.width = sw;
  binCanvas.height = sh;
  const binCtx = binCanvas.getContext("2d", { willReadFrequently: true })!;
  const binImg = binCtx.createImageData(sw, sh);
  // Fill background white.
  for (let i = 0; i < sw * sh; i++) {
    const k = i * 4;
    binImg.data[k] = 255;
    binImg.data[k + 1] = 255;
    binImg.data[k + 2] = 255;
    binImg.data[k + 3] = 255;
  }
  for (let i = 0; i < sw * sh; i++) {
    const k = i * 4;
    if (data[k + 3] < 128) continue;
    const dr = data[k] - colour.r;
    const dg = data[k + 1] - colour.g;
    const db = data[k + 2] - colour.b;
    if (dr * dr + dg * dg + db * db <= tol * tol) {
      sourceMask[i] = 1;
      // Black for potrace.
      binImg.data[k] = 0;
      binImg.data[k + 1] = 0;
      binImg.data[k + 2] = 0;
    }
  }
  binCtx.putImageData(binImg, 0, 0);

  // 2. Run potrace.
  const { PotracePlus } = await import("potrace-plus");
  // potrace-plus accepts an HTMLImageElement / Canvas / ImageData. We pass
  // the binary canvas. Options tuned for clean letterforms:
  //   turdsize  : suppress speckles (anti-alias nibbles around edges)
  //   alphamax  : 1.0 = aggressive corner fitting (sharp letter corners)
  //   optcurve  : true → smooth Bezier optimisation pass
  //   opttolerance : 0.2 = tight tolerance, more accurate paths
  //   crop      : false → keep paths in original coordinate space so we
  //               know where to composite
  //   decimals  : 2 → compact path data
  const result = await PotracePlus(binCanvas, {
    turdsize: opts.turdSize ?? 2,
    alphamax: 1.0,
    optcurve: true,
    opttolerance: 0.2,
    crop: false,
    addDimensions: true,
    decimals: 2,
  });
  const pathD = (result?.d ?? result?.getD?.()) as string | undefined;

  // 3. Render the resulting path at target resolution, in the original
  // colour. The path is in source-pixel coordinates → scale by tw/sw, th/sh.
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  if (pathD) {
    ctx.fillStyle = colour.hex;
    ctx.scale(tw / sw, th / sh);
    const path = new Path2D(pathD);
    ctx.fill(path);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  return { hex: colour.hex, canvas: out, sourceMask };
}

// ─── Composition ────────────────────────────────────────────────────────

/**
 * Composite vector-text overlays on top of a Lanczos-resampled base.
 *
 * Two masks gate every overlay pixel:
 *
 *   1. SOURCE MASK (per overlay) — built during vectorisation. Tells us
 *      where the text colour was in the trace source (which may be the
 *      pristine upload, NOT the cutout). The mask is dilated by a few
 *      source-pixels so the AA halo around each letter — pixels that are
 *      the text colour partially mixed with the neighbour — also gets
 *      replaced. Without this, a 1-px ghosted "halo" of the original
 *      text bleeds out from under the vector overlay.
 *
 *   2. BASE-REACH MASK (cross-overlay) — derived from the BASE alpha
 *      channel. The vector overlay can only paint where the base is
 *      opaque or within `reachDilatePx` of an opaque pixel. Why:
 *
 *      - When the trace source is the pristine upload (pre-BG-removal),
 *        the source mask includes text that may have been damaged or
 *        manually erased downstream. We don't want to "resurrect" any
 *        text the user explicitly removed via lasso/brush.
 *      - But we DO want to bridge small (1–4 px) gaps where BG removal
 *        ate part of a letter's anti-alias edge — that's the whole
 *        point of vectorising before BG removal.
 *
 *      A small reach (default 4 target-px ≈ 3 source-px) accomplishes
 *      both: bridges damage, doesn't bridge intentional erasures (which
 *      are typically much larger than 4 px).
 */
export function composeVectorOverlays(
  base: HTMLCanvasElement,
  source: HTMLCanvasElement,
  overlays: VectorizedColourResult[],
  options: { dilatePx?: number; reachDilatePx?: number } = {}
): HTMLCanvasElement {
  const dilate = options.dilatePx ?? 2;
  const reach = options.reachDilatePx ?? 4;
  const tw = base.width;
  const th = base.height;
  const sw = source.width;
  const sh = source.height;

  const baseImg = canvasToImageData(base);
  const out = new ImageData(new Uint8ClampedArray(baseImg.data), tw, th);

  // Build the base-reach mask: target pixels where the base is opaque or
  // within `reach` pixels of an opaque pixel. Only computed once — shared
  // across all overlays.
  const baseAlphaMask = new Uint8Array(tw * th);
  for (let i = 0; i < tw * th; i++) {
    if (baseImg.data[i * 4 + 3] >= 16) baseAlphaMask[i] = 1;
  }
  const baseReach = reach > 0 ? dilateMask(baseAlphaMask, tw, th, reach) : baseAlphaMask;

  for (const layer of overlays) {
    const dilated = dilateMask(layer.sourceMask, sw, sh, dilate);
    const overlayImg = canvasToImageData(layer.canvas);
    const od = overlayImg.data;
    // For every target pixel, sample whether the corresponding source
    // pixel was in the dilated mask AND whether the base is in reach.
    // Nearest-neighbour mapping is fine here because we're only deciding
    // a binary inclusion test, not an interpolation.
    for (let y = 0; y < th; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / th));
      const srcRow = sy * sw;
      const dstRow = y * tw;
      for (let x = 0; x < tw; x++) {
        const targetIdx = dstRow + x;
        if (!baseReach[targetIdx]) continue;
        const sx = Math.min(sw - 1, Math.floor((x * sw) / tw));
        if (!dilated[srcRow + sx]) continue;
        const k = targetIdx * 4;
        // Alpha-composite the overlay over the base. Overlay alpha tells
        // us the AA edges of the rendered letter; we honour them so the
        // composite has clean sub-pixel transitions instead of a hard
        // colour swap.
        const oa = od[k + 3] / 255;
        if (oa <= 0) continue;
        out.data[k] = od[k] * oa + out.data[k] * (1 - oa);
        out.data[k + 1] = od[k + 1] * oa + out.data[k + 1] * (1 - oa);
        out.data[k + 2] = od[k + 2] * oa + out.data[k + 2] * (1 - oa);
        // Alpha: take the max so we don't accidentally erase pixels that
        // were already opaque.
        out.data[k + 3] = Math.max(out.data[k + 3], od[k + 3]);
      }
    }
  }
  return imageDataToCanvas(out);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Connected-components bounding-box-heights of a binary mask. 4-connected.
 * Uses an iterative DFS so the JS call stack doesn't blow up on huge
 * components (up to millions of pixels).
 */
function componentBoundingBoxHeights(
  mask: Uint8Array,
  w: number,
  h: number
): number[] {
  const visited = new Uint8Array(w * h);
  const heights: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 1 || visited[i]) continue;
    let minY = Infinity;
    let maxY = -Infinity;
    let count = 0;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const y = (idx / w) | 0;
      const x = idx - y * w;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
      if (x > 0 && mask[idx - 1] === 1 && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        stack.push(idx - 1);
      }
      if (x < w - 1 && mask[idx + 1] === 1 && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        stack.push(idx + 1);
      }
      if (y > 0 && mask[idx - w] === 1 && !visited[idx - w]) {
        visited[idx - w] = 1;
        stack.push(idx - w);
      }
      if (y < h - 1 && mask[idx + w] === 1 && !visited[idx + w]) {
        visited[idx + w] = 1;
        stack.push(idx + w);
      }
    }
    // Skip 1-px speckles — they distort the median.
    if (count >= 4) heights.push(maxY - minY + 1);
  }
  return heights;
}

/** Morphological dilation of a binary mask by a given pixel radius. */
function dilateMask(
  mask: Uint8Array,
  w: number,
  h: number,
  radius: number
): Uint8Array {
  if (radius <= 0) return mask;
  // Two passes of a 1D dilation (separable) — each pass radius pixels.
  let cur = new Uint8Array(mask);
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(w * h);
    // Horizontal.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (
          cur[i] ||
          (x > 0 && cur[i - 1]) ||
          (x < w - 1 && cur[i + 1])
        ) {
          next[i] = 1;
        }
      }
    }
    cur = next;
    const next2 = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (
          cur[i] ||
          (y > 0 && cur[i - w]) ||
          (y < h - 1 && cur[i + w])
        ) {
          next2[i] = 1;
        }
      }
    }
    cur = next2;
  }
  return cur;
}
