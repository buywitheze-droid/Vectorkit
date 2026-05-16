/**
 * Phone-screenshot extractor for acrylic-invite designs.
 *
 * Audience: people who receive invitation PNGs via Gmail / Chrome / etc.
 * on their phone and screenshot them. The screenshot bakes in:
 *
 *   ┌──────────────────────────────────┐
 *   │  status bar (time / battery)     │  ← phone OS chrome
 *   │  [back] filename.png  [⋮ menu]   │  ← Gmail / Chrome chrome
 *   │  ████████████████████████████    │  ← black letterbox
 *   │  ░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░    │  ┐
 *   │  ░▒  the actual transparent  ▒░  │  │ checker pattern around the
 *   │  ░▒  invitation design here  ▒░  │  │ design = the gallery's way
 *   │  ░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░▒░    │  ┘ of showing transparency
 *   │  ████████████████████████████    │  ← black letterbox
 *   │  ─── ○ ◁  (nav bar)             │  ← phone OS chrome
 *   └──────────────────────────────────┘
 *
 * Goal: recover the original transparent PNG.
 *
 * Pipeline:
 *   1. detectCheckerboard          — sniff the 2 grey colors + cell size
 *   2. detectDesignBoundingBox     — crop everything outside the checker
 *                                    region (phone + app chrome)
 *   3. removeCheckerboard          — replace each checker pixel with
 *                                    alpha=0 using a SPATIAL detector
 *                                    (not just colour) so white pixels
 *                                    inside the design (text, dress
 *                                    highlights) aren't accidentally
 *                                    nuked.
 *
 * If `detectCheckerboard` returns null, this is NOT a screenshot → the
 * caller should route to the existing chromakey/AI pipeline instead.
 */

import { canvasToImageData, imageDataToCanvas, type RGBA } from "./canvas";

export interface CheckerSpec {
  /** The lighter of the two checker greys (0–255 RGB). */
  light: RGBA;
  /** The darker of the two checker greys. */
  dark: RGBA;
  /** Estimated cell size in pixels (one square of the pattern). */
  cellSize: number;
  /** How confident we are this is a real checker (0–1). */
  confidence: number;
}

export interface DesignBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractScreenshotResult {
  /** Final cropped + transparent canvas, ready to download. */
  canvas: HTMLCanvasElement;
  /** What the bounding box of the design ended up being. */
  box: DesignBox;
  /** What checker pattern was detected. */
  checker: CheckerSpec;
  /** How many pixels were converted from checker to alpha=0. */
  pixelsRemoved: number;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Try to detect a transparency-preview checkerboard pattern in the image.
 *
 * Strategy: sample many pixels from the interior of the image, keep only
 * the near-greyscale ones, find the two dominant grey clusters. If they're
 * far enough apart (so they're clearly two different colors, not just one
 * color with noise) AND each is sufficiently common (so they really are
 * dominant, not stragglers), we have a checker.
 *
 * Cell size is estimated from the median spacing between colour-flips along
 * a horizontal scan line in the suspected checker region.
 */
export function detectCheckerboard(canvas: HTMLCanvasElement): CheckerSpec | null {
  const imageData = canvasToImageData(canvas);
  const { data, width: w, height: h } = imageData;

  // Sample a generous slice of the interior. We avoid the outer 5% rim
  // (which can be phone chrome) but otherwise cover most of the image.
  const yStart = Math.floor(h * 0.05);
  const yEnd = Math.floor(h * 0.95);
  const xStart = Math.floor(w * 0.05);
  const xEnd = Math.floor(w * 0.95);
  const stride = Math.max(2, Math.floor(Math.min(w, h) / 250));

  // Histogram of grey luminance, 4-step buckets (64 buckets total).
  const NB = 64;
  const bucketStep = 256 / NB;
  const hist = new Uint32Array(NB);
  let totalGreySamples = 0;
  let totalSamples = 0;

  for (let y = yStart; y < yEnd; y += stride) {
    for (let x = xStart; x < xEnd; x += stride) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      totalSamples++;
      // Greyscale-ness check: max - min ≤ 8. Real checker greys are
      // perfectly neutral; allow a small tolerance for JPEG noise.
      if (Math.max(r, g, b) - Math.min(r, g, b) > 8) continue;
      const lum = (r + g + b) / 3;
      hist[Math.min(NB - 1, Math.floor(lum / bucketStep))]++;
      totalGreySamples++;
    }
  }

  // Need at least 8 % of all sampled pixels to be greyscale, otherwise
  // this image is mostly colourful → unlikely to be a checker screenshot.
  if (totalGreySamples < totalSamples * 0.08 || totalGreySamples < 200) {
    return null;
  }

  // Find the two best CHECKER-CANDIDATE peaks. We restrict the search to
  // luminance 80..255 because:
  //   • pure-black peaks (lum < 16) are always phone OS chrome (status
  //     bar, letterbox, nav bar) — never a transparency-checker colour;
  //   • Android / iOS galleries always render the checker in the upper
  //     half of the value range (light grey + white, or off-white +
  //     pure white).
  // Within that range we pick the BEST PAIR — both peaks above 5 % of
  // grey samples, gap in [12, 100] lum — that maximises combined count.
  // This handles the common case where pure-black phone chrome would
  // otherwise dominate a naive top-2 search.
  const peakCandidates: { idx: number; count: number }[] = [];
  const minBucket = Math.floor(80 / bucketStep);
  for (let i = minBucket; i < NB; i++) {
    if (hist[i] > 0) peakCandidates.push({ idx: i, count: hist[i] });
  }
  peakCandidates.sort((a, b) => b.count - a.count);

  // Walk the top candidates and pick the best valid pair.
  let p1 = -1;
  let p2 = -1;
  let p1Count = 0;
  let p2Count = 0;
  let bestPairScore = 0;
  const TOP_N = Math.min(peakCandidates.length, 12);
  for (let i = 0; i < TOP_N; i++) {
    for (let j = i + 1; j < TOP_N; j++) {
      const a = peakCandidates[i];
      const b = peakCandidates[j];
      const gap = Math.abs(a.idx - b.idx) * bucketStep;
      if (gap < 12 || gap > 100) continue;
      // Local-maxima check: each candidate must be strictly larger than
      // its immediate neighbours to avoid grabbing a wide hump's two sides.
      const isLocalMax = (c: { idx: number; count: number }) =>
        (c.idx === minBucket || hist[c.idx] >= hist[c.idx - 1]) &&
        (c.idx === NB - 1 || hist[c.idx] >= hist[c.idx + 1]);
      if (!isLocalMax(a) || !isLocalMax(b)) continue;
      const score = a.count + b.count;
      if (score > bestPairScore) {
        bestPairScore = score;
        p1 = a.idx;
        p2 = b.idx;
        p1Count = a.count;
        p2Count = b.count;
      }
    }
  }
  if (p1 < 0 || p2 < 0) {
    return null;
  }

  // Both peaks must each contain at least 4 % of the grey samples —
  // weeds out one-color images where the second peak is just JPEG noise.
  const minPeakShare = 0.04;
  if (
    p1Count < totalGreySamples * minPeakShare ||
    p2Count < totalGreySamples * minPeakShare
  ) {
    return null;
  }

  // Refine each peak to a precise mean colour by averaging all greyscale
  // samples within ±1 bucket of the peak.
  const refine = (peakBucket: number) => {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let n = 0;
    const lo = (peakBucket - 1) * bucketStep;
    const hi = (peakBucket + 2) * bucketStep;
    for (let y = yStart; y < yEnd; y += stride) {
      for (let x = xStart; x < xEnd; x += stride) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 8) continue;
        const lum = (r + g + b) / 3;
        if (lum < lo || lum >= hi) continue;
        sumR += r;
        sumG += g;
        sumB += b;
        n++;
      }
    }
    if (n === 0) return null;
    return {
      r: Math.round(sumR / n),
      g: Math.round(sumG / n),
      b: Math.round(sumB / n),
      a: 255,
      n,
    };
  };

  const c1 = refine(p1);
  const c2 = refine(p2);
  if (!c1 || !c2) return null;

  const lumOf = (c: { r: number; g: number; b: number }) => (c.r + c.g + c.b) / 3;
  const light: RGBA = lumOf(c1) >= lumOf(c2) ? c1 : c2;
  const dark: RGBA = lumOf(c1) >= lumOf(c2) ? c2 : c1;

  // Estimate cell size by brute-force scoring each plausible size.
  const cellSize = estimateCellSize(data, w, h, light, dark);
  if (cellSize === 0) return null;

  // Confidence: combined share of the two peaks (capped at 1).
  const confidence = Math.min(
    1,
    (p1Count + p2Count) / Math.max(1, totalGreySamples)
  );

  return { light, dark, cellSize, confidence };
}

/**
 * Find the bounding box of the "design + checkerboard" region — anything
 * outside it is phone OS chrome / app chrome / black letterbox and gets
 * cropped away.
 *
 * Robustness comes from counting only the DARK-grey checker colour
 * (e.g. #d9d9d9) per row / per column — NOT the light one. Why:
 *   • the light colour is usually pure white, which appears all over
 *     the place in a screenshot (status-bar text, app-chrome backgrounds,
 *     filename headers, white-fill design pixels). Counting it lets
 *     phone chrome rows clear the threshold and survive the crop.
 *   • the dark grey #d9d9d9 (or whatever the gallery uses) is a precise
 *     non-design colour. It basically only appears in the gallery's
 *     transparency-preview pattern. So a row's dark-grey count is a
 *     near-perfect signal for "this row is inside the checker area."
 */
export function detectDesignBoundingBox(
  canvas: HTMLCanvasElement,
  checker: CheckerSpec
): DesignBox {
  const imageData = canvasToImageData(canvas);
  const { data, width: w, height: h } = imageData;

  const tol = 22;
  const tolSq = tol * tol;
  const dr = checker.dark.r;
  const dg = checker.dark.g;
  const db = checker.dark.b;

  const rowCount = new Uint32Array(h);
  const colCount = new Uint32Array(w);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dD =
        (r - dr) * (r - dr) + (g - dg) * (g - dg) + (b - db) * (b - db);
      if (dD <= tolSq) {
        rowCount[y]++;
        colCount[x]++;
      }
    }
  }

  // A row counts as "in design region" if its dark-grey count is at
  // least 1.5 % of width. Phone chrome rows have ~zero dark-grey pixels,
  // but JPEG noise around UI icons can occasionally bump a single
  // status-bar row to 5–20 spurious matches — so we don't trust ANY
  // individual row crossing the threshold. Instead we find the LARGEST
  // CONTIGUOUS RUN of high-count rows and use that run's bounds. The
  // real design region is always thousands of pixels long; isolated
  // noisy rows are 1–2 pixels long and never compete.
  const rowThr = Math.max(6, Math.floor(w * 0.015));
  const colThr = Math.max(6, Math.floor(h * 0.015));

  const longestRun = (counts: Uint32Array, thr: number): [number, number] => {
    let bestStart = 0;
    let bestLen = 0;
    let curStart = -1;
    // Allow short gaps (≤ 4 px) inside a run — the design itself can
    // briefly span the whole row, dropping the dark-grey count for a
    // pixel or two without the run actually ending.
    let gap = 0;
    const GAP_TOLERANCE = 4;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= thr) {
        if (curStart < 0) curStart = i;
        gap = 0;
      } else if (curStart >= 0) {
        gap++;
        if (gap > GAP_TOLERANCE) {
          const runLen = i - gap - curStart + 1;
          if (runLen > bestLen) {
            bestLen = runLen;
            bestStart = curStart;
          }
          curStart = -1;
          gap = 0;
        }
      }
    }
    if (curStart >= 0) {
      const runLen = counts.length - gap - curStart;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = curStart;
      }
    }
    return [bestStart, bestStart + bestLen - 1];
  };

  const [y0, y1] = longestRun(rowCount, rowThr);
  const [x0, x1] = longestRun(colCount, colThr);

  if (y1 <= y0 || x1 <= x0) {
    return { x: 0, y: 0, width: w, height: h };
  }

  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * Replace the checkerboard pattern with real alpha=0, in-place on a
 * cropped canvas (use `detectDesignBoundingBox` first; this function
 * assumes the input is already trimmed to the design region).
 *
 * Algorithm — SPATIAL detector, not just colour. A pixel is "checker"
 * iff its colour is close to a checker grey AND its 4 neighbours at
 * distance `cellSize` (i.e. the 4 adjacent CELLS in N/S/E/W) are
 * dominantly the OPPOSITE checker colour.
 *
 * Why spatial: for designs with WHITE fill (text, dress highlights,
 * flower centres), the checker's lighter colour can equal pure white.
 * A pure colour-distance test would erase the white design. The spatial
 * test rescues those: white pixels inside an opaque design are
 * surrounded by more white / colour, NOT alternating to dark grey at
 * the cell-size offset, so they're preserved.
 */
export function removeCheckerboard(
  canvas: HTMLCanvasElement,
  checker: CheckerSpec
): { canvas: HTMLCanvasElement; pixelsRemoved: number } {
  const imageData = canvasToImageData(canvas);
  const { data, width: w, height: h } = imageData;
  const N = w * h;

  const tol = 24;
  const tolSq = tol * tol;
  const lr = checker.light.r;
  const lg = checker.light.g;
  const lb = checker.light.b;
  const dr = checker.dark.r;
  const dg = checker.dark.g;
  const db = checker.dark.b;

  // Step 1 — classify every pixel: 0=other, 1=light-checker-coloured,
  // 2=dark-checker-coloured.
  const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = i * 4;
    const r = data[k];
    const g = data[k + 1];
    const b = data[k + 2];
    const dL = (r - lr) * (r - lr) + (g - lg) * (g - lg) + (b - lb) * (b - lb);
    const dD = (r - dr) * (r - dr) + (g - dg) * (g - dg) + (b - db) * (b - db);
    if (dL <= tolSq && dL <= dD) cls[i] = 1;
    else if (dD <= tolSq) cls[i] = 2;
    else cls[i] = 0;
  }

  // Step 2 — for each light/dark pixel, look at the 4 cardinal cells at
  // distance cellSize. At least HALF of the in-bounds neighbours that are
  // also classified must be the OPPOSITE colour. That confirms the
  // alternating grid pattern.
  const cs = checker.cellSize;
  const isChecker = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = cls[i];
      if (c === 0) continue;
      const opp = c === 1 ? 2 : 1;
      let totalNeighbours = 0;
      let oppositeCount = 0;
      // Look in 4 cardinal directions at ±cellSize.
      const dirs = [
        [cs, 0],
        [-cs, 0],
        [0, cs],
        [0, -cs],
      ] as const;
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        const nc = cls[ni];
        if (nc === 0) continue;
        totalNeighbours++;
        if (nc === opp) oppositeCount++;
      }
      // Need at least 2 confirming neighbours, and ≥ 2/3 must agree.
      if (totalNeighbours >= 2 && oppositeCount >= Math.ceil(totalNeighbours * 0.66)) {
        isChecker[i] = 1;
      }
    }
  }

  // Step 3 — morphological closure: a pixel that 8-touches at least 3
  // checker pixels AND was classified as a checker colour is also
  // checker. Catches the small interior fringe at the border between
  // checker cells where the diagonal-neighbour test would reject them.
  const closed = new Uint8Array(isChecker);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (closed[i]) continue;
      if (cls[i] === 0) continue;
      let n = 0;
      if (isChecker[i - 1]) n++;
      if (isChecker[i + 1]) n++;
      if (isChecker[i - w]) n++;
      if (isChecker[i + w]) n++;
      if (isChecker[i - w - 1]) n++;
      if (isChecker[i - w + 1]) n++;
      if (isChecker[i + w - 1]) n++;
      if (isChecker[i + w + 1]) n++;
      if (n >= 3) closed[i] = 1;
    }
  }

  // Step 4 — apply: every checker pixel becomes alpha=0.
  let pixelsRemoved = 0;
  for (let i = 0; i < N; i++) {
    if (closed[i]) {
      data[i * 4 + 3] = 0;
      pixelsRemoved++;
    }
  }

  return { canvas: imageDataToCanvas(imageData), pixelsRemoved };
}

/**
 * One-call extractor: detect → crop chrome → remove checker. Returns
 * everything the UI needs to show the result and let the user adjust.
 *
 * Throws if the image isn't recognisable as a checker screenshot — caller
 * should fall back to the chromakey / AI pipeline in that case.
 */
export function extractFromScreenshot(
  source: HTMLCanvasElement
): ExtractScreenshotResult {
  const checker = detectCheckerboard(source);
  if (!checker) {
    throw new Error("Not a checkerboard screenshot");
  }
  const box = detectDesignBoundingBox(source, checker);
  const cropped = cropToBox(source, box);
  const { canvas, pixelsRemoved } = removeCheckerboard(cropped, checker);
  return { canvas, box, checker, pixelsRemoved };
}

/**
 * Source-type classifier — decides which extraction pipeline the wizard
 * should run for this upload.
 *
 *   - "screenshot" → image is a phone screenshot of a transparent PNG
 *     viewed in a gallery / email / browser. The transparency is faked
 *     with a checker preview pattern. Use `extractFromScreenshot`.
 *   - "graphic"    → image is a regular design with a real solid-colour
 *     background (white, black, etc.). Use the existing chromakey / AI
 *     pipeline.
 *
 * Detection is just "did `detectCheckerboard` find a valid pattern?" — it
 * already requires both checker greys to be present in real proportions
 * and a valid alternating cell size, so a false positive on a flat-BG
 * graphic is essentially impossible.
 */
export function detectSourceType(
  canvas: HTMLCanvasElement
): "screenshot" | "graphic" {
  return detectCheckerboard(canvas) ? "screenshot" : "graphic";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function estimateCellSize(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  light: RGBA,
  dark: RGBA
): number {
  // Strategy: brute-force evaluate each candidate cell size by counting
  // how well the actual pixels FIT the alternating checker pattern at
  // that size. For each candidate `cs`, sample classified pixels across
  // the whole image; for each sample, look at its 4 cardinal neighbours
  // at distance `cs` and check whether they are dominantly the OPPOSITE
  // class. The cell size with the highest "alternation match" rate wins.
  //
  // Why this beats scan-line flip-distance modes: design content (gold
  // filigree, fine text) creates spurious tight flips at 4–6 px that
  // dominate naive mode estimates. The pattern-fit score, in contrast,
  // is HIGHEST at the true cell size because the spatial structure
  // exists at that scale and at no other.
  const N = w * h;
  const tol2 = 24 * 24;

  // Step 1 — classify every pixel: 0=other, 1=light, 2=dark.
  const cls = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = i * 4;
    const r = data[k];
    const g = data[k + 1];
    const b = data[k + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 12) continue;
    const dL =
      (r - light.r) * (r - light.r) +
      (g - light.g) * (g - light.g) +
      (b - light.b) * (b - light.b);
    const dD =
      (r - dark.r) * (r - dark.r) +
      (g - dark.g) * (g - dark.g) +
      (b - dark.b) * (b - dark.b);
    if (dL < tol2 && dL <= dD) cls[i] = 1;
    else if (dD < tol2) cls[i] = 2;
  }

  // Step 2 — try each candidate cell size and score it.
  const candidates = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30, 36];
  let bestSize = 0;
  let bestScore = 0;
  // Sub-sample for speed: evaluate at every ~4th pixel.
  const sampleStride = Math.max(2, Math.floor(Math.min(w, h) / 400));

  for (const cs of candidates) {
    if (cs >= w || cs >= h) continue;
    let alternations = 0;
    let evaluated = 0;
    for (let y = cs; y < h - cs; y += sampleStride) {
      for (let x = cs; x < w - cs; x += sampleStride) {
        const i = y * w + x;
        const c = cls[i];
        if (c === 0) continue;
        const opp = c === 1 ? 2 : 1;
        let oppCount = 0;
        let nbrCount = 0;
        const right = cls[i + cs];
        if (right !== 0) {
          nbrCount++;
          if (right === opp) oppCount++;
        }
        const left = cls[i - cs];
        if (left !== 0) {
          nbrCount++;
          if (left === opp) oppCount++;
        }
        const down = cls[i + cs * w];
        if (down !== 0) {
          nbrCount++;
          if (down === opp) oppCount++;
        }
        const up = cls[i - cs * w];
        if (up !== 0) {
          nbrCount++;
          if (up === opp) oppCount++;
        }
        if (nbrCount >= 2 && oppCount >= Math.ceil(nbrCount * 0.66)) {
          alternations++;
        }
        evaluated++;
      }
    }
    if (evaluated === 0) continue;
    const score = alternations / evaluated;
    if (score > bestScore) {
      bestScore = score;
      bestSize = cs;
    }
  }

  // Need a meaningful match rate — if the best candidate only matches
  // ~5 % of classified pixels, this isn't a real checker.
  if (bestScore < 0.12) return 0;
  return bestSize;
}

function cropToBox(source: HTMLCanvasElement, box: DesignBox): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = box.width;
  out.height = box.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    box.width,
    box.height
  );
  return out;
}
