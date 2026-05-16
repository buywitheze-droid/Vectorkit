/**
 * Color-based background removal (chromakey).
 *
 * Two strategies:
 *  - "global" : remove ALL pixels matching the target color (within tolerance).
 *               Fast, perfect for designs where the background color does not
 *               appear inside the design itself.
 *  - "flood"  : flood-fill from the image edges only. Removes connected
 *               background while preserving any matching color enclosed inside
 *               the design (e.g. white highlights inside a pink flower).
 *
 * Both produce smooth anti-aliased alpha edges.
 */

import {
  canvasToImageData,
  hexToRgb,
  imageDataToCanvas,
  imageToCanvas,
} from "./canvas";

export type ChromakeyStrategy = "global" | "flood";

export interface ChromakeyOptions {
  /** Target color in #rrggbb form. */
  color: string;
  /** Tolerance 0–100. Higher = removes more shades near the target. */
  tolerance: number;
  /** Anti-aliasing softness in alpha pixels. */
  edgeFeather?: number;
  strategy: ChromakeyStrategy;
}

export async function chromakey(
  img: HTMLImageElement,
  opts: ChromakeyOptions
): Promise<HTMLCanvasElement> {
  const canvas = imageToCanvas(img);
  const imageData = canvasToImageData(canvas);
  const { color, tolerance, strategy, edgeFeather = 1 } = opts;
  const { r: tr, g: tg, b: tb } = hexToRgb(color);

  // Convert tolerance (0–100%) to a max squared color distance.
  // Max squared distance between two RGB colors is 3 * 255^2 = 195075.
  const maxDistSq = (tolerance / 100) ** 2 * 195075;

  if (strategy === "global") {
    applyGlobalChromakey(imageData, tr, tg, tb, maxDistSq);
  } else {
    applyFloodFillChromakey(imageData, tr, tg, tb, maxDistSq);
  }

  if (edgeFeather > 0) {
    featherAlpha(imageData, edgeFeather);
  }

  return imageDataToCanvas(imageData);
}

function applyGlobalChromakey(
  imageData: ImageData,
  tr: number,
  tg: number,
  tb: number,
  maxDistSq: number
) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq <= maxDistSq) {
      data[i + 3] = 0;
    }
  }
}

// ─── Smart erase (depth-limited flood) ─────────────────────────────────────
//
// Standalone export for the wizard — the canonical "remove the background
// without eating the design" algorithm. Two improvements over the basic
// flood-fill chromakey:
//
//   1. Two-tier color match. Pure-BG pixels (distance ≤ tightTolerance)
//      are unrestricted: the flood walks freely across the whole canvas.
//      Fringe pixels (within fringeTolerance) match too — but each
//      consecutive fringe step is counted, and the flood stops after
//      `maxFringeSteps` of them.
//
//   2. The fringe budget is reset every time the flood traverses a pure
//      BG pixel, so a pure-BG island next to a fringe band still gets
//      its own 3-step budget on the other side.
//
// Why this matters: a pink dress on a white background has an anti-alias
// chain pure-white → pink-white → light-pink → pink. The basic flood
// follows that chain 5–10 pixels into the dress before the color
// distance finally exceeds tolerance. With maxFringeSteps=3, the chain
// gets cut off after 3 fringe traversals — well before reaching real
// dress pixels. Same logic preserves white-centered flowers and
// gold-on-white crowns.
//
// Edges of the cutout end up sharp (no anti-alias). For DTF the caller
// can apply a 1px alpha feather afterward; for screen viewing, that
// usually isn't needed because the underlying anti-alias is already in
// the surviving fringe pixels nearer the design.

export interface SmartEraseOptions {
  /** Hex color of the background to remove. */
  bgColor: string;
  /**
   * Max distance (0–100, % of max RGB distance) for "this is definitely
   * the background, walk freely". Default 3.
   */
  tightTolerance?: number;
  /**
   * Max distance for "this might be anti-aliased background fringe — walk
   * but count steps". Should be > tightTolerance. Default 10.
   */
  fringeTolerance?: number;
  /**
   * After this many consecutive fringe steps, stop propagating. Default
   * 3 (handles 1–3 pixel anti-alias bands without leaking into design).
   */
  maxFringeSteps?: number;
  /** Optional alpha box-blur of the resulting cutout edge. Default 0. */
  edgeFeather?: number;
}

export async function smartErase(
  img: HTMLImageElement,
  opts: SmartEraseOptions
): Promise<HTMLCanvasElement> {
  const canvas = imageToCanvas(img);
  const imageData = canvasToImageData(canvas);
  const tightTol = opts.tightTolerance ?? 3;
  const fringeTol = opts.fringeTolerance ?? 10;
  const maxFringe = opts.maxFringeSteps ?? 3;
  const feather = opts.edgeFeather ?? 0;
  const { r: tr, g: tg, b: tb } = hexToRgb(opts.bgColor);

  applyDepthLimitedFlood(
    imageData,
    tr,
    tg,
    tb,
    (tightTol / 100) ** 2 * 195075,
    (fringeTol / 100) ** 2 * 195075,
    maxFringe
  );

  if (feather > 0) {
    featherAlpha(imageData, feather);
  }

  return imageDataToCanvas(imageData);
}

function applyDepthLimitedFlood(
  imageData: ImageData,
  tr: number,
  tg: number,
  tb: number,
  tightDistSq: number,
  fringeDistSq: number,
  maxFringeSteps: number
) {
  const { width, height, data } = imageData;
  // Track the BEST fringe-depth at which each pixel was visited. A pixel
  // visited at depth N might still be re-explorable from a neighbor that
  // arrives at depth M < N (because that arrival is "fresher" — it has
  // more remaining fringe budget). Initialize to maxFringe + 1 so any
  // legitimate visit improves it.
  const bestDepth = new Uint8Array(width * height).fill(maxFringeSteps + 1);

  const distSqAt = (idx: number) => {
    const dr = data[idx] - tr;
    const dg = data[idx + 1] - tg;
    const db = data[idx + 2] - tb;
    return dr * dr + dg * dg + db * db;
  };

  // Queue of [x, y, depth]. Plain arrays are faster than typed arrays for
  // this push/shift pattern up to a few million pixels.
  const queue: number[] = [];

  const tryEnqueue = (x: number, y: number, parentDepth: number) => {
    const i = y * width + x;
    const idx = i * 4;
    // Already transparent? Skip.
    if (data[idx + 3] === 0) return;
    const dist = distSqAt(idx);
    if (dist > fringeDistSq) return; // out of range — design pixel
    const newDepth = dist <= tightDistSq ? 0 : parentDepth + 1;
    if (newDepth > maxFringeSteps) return;
    if (newDepth >= bestDepth[i]) return; // already visited as well or better
    bestDepth[i] = newDepth;
    queue.push(x, y, newDepth);
  };

  // Seed: every edge pixel that's at least within fringe range. We let
  // tryEnqueue do the actual gating (so seeds only enter if they qualify).
  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0, 0);
    tryEnqueue(x, height - 1, 0);
  }
  for (let y = 1; y < height - 1; y++) {
    tryEnqueue(0, y, 0);
    tryEnqueue(width - 1, y, 0);
  }

  // BFS. Pop from the head with an index pointer to avoid O(n) shifts.
  let head = 0;
  while (head < queue.length) {
    const x = queue[head++];
    const y = queue[head++];
    const depth = queue[head++];
    const i = y * width + x;
    // bestDepth might have been improved since we enqueued; if so, skip.
    if (depth > bestDepth[i]) continue;
    // Erase this pixel.
    data[i * 4 + 3] = 0;
    // Propagate to 4-neighbors.
    if (x > 0) tryEnqueue(x - 1, y, depth);
    if (x < width - 1) tryEnqueue(x + 1, y, depth);
    if (y > 0) tryEnqueue(x, y - 1, depth);
    if (y < height - 1) tryEnqueue(x, y + 1, depth);
  }
}

/**
 * Flood-fill from every edge pixel that matches the target color.
 * Uses a stack-based scanline fill to avoid recursion blowups on big images.
 */
function applyFloodFillChromakey(
  imageData: ImageData,
  tr: number,
  tg: number,
  tb: number,
  maxDistSq: number
) {
  const { width, height, data } = imageData;
  const visited = new Uint8Array(width * height);

  const matches = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    if (data[idx + 3] === 0) return false; // already transparent
    const dr = data[idx] - tr;
    const dg = data[idx + 1] - tg;
    const db = data[idx + 2] - tb;
    return dr * dr + dg * dg + db * db <= maxDistSq;
  };

  const setTransparent = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    data[idx + 3] = 0;
  };

  const stack: number[] = [];
  // Seed from all edges.
  for (let x = 0; x < width; x++) {
    if (matches(x, 0)) stack.push(x, 0);
    if (matches(x, height - 1)) stack.push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    if (matches(0, y)) stack.push(0, y);
    if (matches(width - 1, y)) stack.push(width - 1, y);
  }

  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const visitIdx = y * width + x;
    if (visited[visitIdx]) continue;
    visited[visitIdx] = 1;
    if (!matches(x, y)) continue;
    setTransparent(x, y);

    if (x > 0 && !visited[visitIdx - 1]) stack.push(x - 1, y);
    if (x < width - 1 && !visited[visitIdx + 1]) stack.push(x + 1, y);
    if (y > 0 && !visited[visitIdx - width]) stack.push(x, y - 1);
    if (y < height - 1 && !visited[visitIdx + width]) stack.push(x, y + 1);
  }
}

// ─── Remove ALL pixels of a color, anywhere on the canvas ─────────────────
//
// Companion to smartErase: the wizard's primary removal is edge-connected
// (so it preserves enclosed whites — flower centers, white-highlighted
// crown details, the inside of letter "O"s). Sometimes the user explicitly
// wants those enclosed BG-color regions gone too — the white in between
// the model's arms and dress, the white inside a letter "B", a leftover
// white speech-bubble inside a frame.
//
// This is just a global chromakey at the same tight tolerance the flood
// uses, followed by the same edge decontamination so the freshly-cut
// boundaries don't leave halos.
//
// Tuned conservatively (default tolerance 3 ≈ ±13 RGB) so it ONLY removes
// pixels that are actually the BG color — light pinks, golds, real design
// colors are untouched.

export interface RemoveColorGlobalOptions {
  /** Hex color to remove globally. */
  color: string;
  /** Tolerance 0–100. Default 3 (matches smartErase tightTolerance). */
  tolerance?: number;
  /** Run decontaminateEdges after to clean halos at new boundaries. Default true. */
  decontaminate?: boolean;
}

export interface RemoveColorGlobalResult {
  canvas: HTMLCanvasElement;
  pixelsRemoved: number;
}

export function removeColorGlobal(
  canvas: HTMLCanvasElement,
  opts: RemoveColorGlobalOptions
): RemoveColorGlobalResult {
  const tolerance = opts.tolerance ?? 3;
  const { r: tr, g: tg, b: tb } = hexToRgb(opts.color);
  const maxDistSq = (tolerance / 100) ** 2 * 195075;

  const imageData = canvasToImageData(canvas);
  const { data } = imageData;
  let pixelsRemoved = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const dr = data[i] - tr;
    const dg = data[i + 1] - tg;
    const db = data[i + 2] - tb;
    if (dr * dr + dg * dg + db * db <= maxDistSq) {
      data[i + 3] = 0;
      pixelsRemoved++;
    }
  }

  let out = imageDataToCanvas(imageData);
  if (opts.decontaminate ?? true) {
    out = decontaminateEdges(out, {
      bgColor: opts.color,
      dropThreshold: 0.4,
      iterations: 1,
      innerSearchRadius: 3,
    });
  }
  return { canvas: out, pixelsRemoved };
}

// ─── Remove enclosed BG-color holes whose walls are THIN ──────────────────
//
// A smarter sibling of removeColorGlobal: instead of erasing every pixel
// of the BG color, we only erase enclosed "holes" whose surrounding wall
// is thinner than `maxSurroundingThickness` pixels.
//
// Why: after smartErase, the only BG-colored pixels left are enclosed
// (edge-connected ones were already removed). But "enclosed" includes
// THREE different kinds of region:
//
//   (a) the inside of letters / fonts — enclosed by a THIN stroke
//       (typically 5–15 px). The user almost always wants these gone.
//   (b) flower white centers, gold-crown white highlights — enclosed by
//       30–50 px of petal / metal. Visual design feature; keep.
//   (c) white highlights on a dress, white in the body of a model —
//       enclosed by 100+ px of dress / skin. Definitely keep.
//
// removeColorGlobal removes (a)+(b)+(c) — too aggressive, eats the
// design. removeEnclosedHoles measures the wall thickness around each
// enclosed blob using a distance transform and only removes (a).
//
// Algorithm:
//   1. Classify pixels: 0 = transparent, 1 = opaque non-target,
//      2 = opaque target color (matches `color` within `tolerance`).
//   2. Build a 4-connected distance map: for each opaque pixel (kind 1
//      or 2), how many steps to the nearest transparent pixel? BFS
//      seeded from every transparent pixel; capped at maxSurrounding-
//      Thickness + 2 for speed.
//   3. Find connected components of kind-2 pixels (the enclosed holes).
//      For each, look at every kind-1 pixel that 4-touches it — those
//      are the WALL pixels around this hole. The MIN distance over
//      those wall pixels = the thinnest part of the wall surrounding
//      this hole.
//   4. If min wall thickness ≤ maxSurroundingThickness, this is a
//      letter-style hole → erase the blob. Otherwise keep.
//
// Edge cases handled:
//   • A hole that touches a transparent pixel directly (would happen
//     if the smartErase missed something on the perimeter): wall
//     distance = 0 → kept (the algorithm refuses to act on edge-
//     connected regions because that means smartErase already would
//     have addressed them if they were BG).

export interface RemoveEnclosedHolesOptions {
  /** Hex color of the holes to target (typically the detected BG color). */
  color: string;
  /** Color match tolerance 0–100. Default 3 (matches smartErase). */
  tolerance?: number;
  /**
   * Max wall thickness (in pixels) for a hole to be considered a "letter
   * hole" eligible for removal. Default 12 — covers normal-weight letter
   * strokes on typical invitation fonts; preserves flower centers
   * (~30 px wall), crown highlights inside thick gold (~20 px wall),
   * dress highlights, gaps surrounded by anatomy.
   */
  maxSurroundingThickness?: number;
  /**
   * Cleanup pass on the resulting cutout edges. Default true.
   */
  decontaminate?: boolean;
}

export interface RemoveEnclosedHolesResult {
  canvas: HTMLCanvasElement;
  pixelsRemoved: number;
  blobsRemoved: number;
  blobsKept: number;
}

export function removeEnclosedHoles(
  canvas: HTMLCanvasElement,
  opts: RemoveEnclosedHolesOptions
): RemoveEnclosedHolesResult {
  const tolerance = opts.tolerance ?? 3;
  const maxThickness = opts.maxSurroundingThickness ?? 12;
  const { r: tr, g: tg, b: tb } = hexToRgb(opts.color);
  const maxDistSq = (tolerance / 100) ** 2 * 195075;

  const imageData = canvasToImageData(canvas);
  const { width: w, height: h, data } = imageData;
  const N = w * h;

  // Step 1 — classify every pixel.
  // 0 = transparent, 1 = opaque non-target, 2 = opaque target color.
  const kind = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const k = i * 4;
    if (data[k + 3] < 128) {
      kind[i] = 0;
    } else {
      const dr = data[k] - tr;
      const dg = data[k + 1] - tg;
      const db = data[k + 2] - tb;
      kind[i] = dr * dr + dg * dg + db * db <= maxDistSq ? 2 : 1;
    }
  }

  // Step 2 — distance transform from transparent. BFS from every
  // transparent pixel; distance is the number of 4-conn steps to reach
  // the first transparent pixel. Capped to `maxThickness + 2` (pixels
  // farther than that don't matter for the decision).
  const cap = maxThickness + 2;
  const distance = new Uint16Array(N).fill(0xffff);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (kind[i] === 0) {
      distance[i] = 0;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const d = distance[i];
    if (d >= cap) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const visit = (ni: number) => {
      if (kind[ni] === 0) return; // already 0
      if (distance[ni] > d + 1) {
        distance[ni] = d + 1;
        queue.push(ni);
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (y > 0) visit(i - w);
    if (y < h - 1) visit(i + w);
  }

  // Step 3 — connected components of kind-2 pixels. For each blob,
  // compute its min wall thickness (min `distance` over the kind-1
  // pixels that 4-touch the blob). Decide remove vs keep.
  const visited = new Uint8Array(N);
  let pixelsRemoved = 0;
  let blobsRemoved = 0;
  let blobsKept = 0;

  for (let seed = 0; seed < N; seed++) {
    if (kind[seed] !== 2 || visited[seed]) continue;

    const blob: number[] = [];
    const stack: number[] = [seed];
    visited[seed] = 1;
    let minWallDist = 0xffff;

    while (stack.length) {
      const i = stack.pop()!;
      blob.push(i);
      const x = i % w;
      const y = (i / w) | 0;

      const considerNeighbor = (ni: number) => {
        if (kind[ni] === 2) {
          if (!visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        } else if (kind[ni] === 1) {
          if (distance[ni] < minWallDist) minWallDist = distance[ni];
        } else {
          // touches transparent → blob is edge-connected; refuse to act.
          minWallDist = 0;
        }
      };

      if (x > 0) considerNeighbor(i - 1);
      if (x < w - 1) considerNeighbor(i + 1);
      if (y > 0) considerNeighbor(i - w);
      if (y < h - 1) considerNeighbor(i + w);
    }

    // 0 means edge-connected (let smartErase handle that, not us).
    // Any value 1..maxThickness is a thin-walled hole → erase.
    if (minWallDist > 0 && minWallDist <= maxThickness) {
      for (const idx of blob) data[idx * 4 + 3] = 0;
      pixelsRemoved += blob.length;
      blobsRemoved++;
    } else {
      blobsKept++;
    }
  }

  let out = imageDataToCanvas(imageData);
  if (opts.decontaminate ?? true) {
    out = decontaminateEdges(out, {
      bgColor: opts.color,
      dropThreshold: 0.4,
      iterations: 1,
      innerSearchRadius: 3,
    });
  }
  return { canvas: out, pixelsRemoved, blobsRemoved, blobsKept };
}

// ─── Thicken thin design lines (print-prep) ────────────────────────────────
//
// DTF / sublimation / vinyl printers can't reliably render strokes thinner
// than ~3 px @ 300 DPI. Hairline script fonts and thin letter outlines
// often arrive at 1–2 px wide and either drop out completely or print as
// broken dotted lines.
//
// Fix: morphological dilation of the colored design pixels INTO adjacent
// BG pixels. Each pass grows every design boundary by 1 pixel. A 1-pass
// dilation:
//   • turns 1-px hairlines into 3-px lines (300 % thicker — print-safe)
//   • turns 2-px outlines into 4-px outlines (100 % thicker)
//   • turns a 100-px-wide dress into 102-px-wide dress (2 % — invisible)
//
// Run BEFORE smartErase so the result is sharp colored edges against
// solid BG rather than soft-edged transparent pixels.
//
// Each new pixel takes the FARTHEST-FROM-BG neighbor's color (i.e. the
// most-saturated / "core" stroke color, ignoring anti-alias halo) so that
// a 1-px black hairline dilates into pure black instead of muddy gray,
// and a red letter dilates into pure red instead of pink.

export interface ThickenDesignLinesOptions {
  /** Hex color of the BG that we dilate INTO. */
  bgColor: string;
  /** BG match tolerance 0–100. Default 5 — slightly looser than smartErase
   *  so anti-alias halo around the design is treated as BG and gets
   *  overwritten with crisp design color. */
  bgTolerance?: number;
  /** How many 1-px dilation passes. Default 1; use 2 for very thin script. */
  passes?: number;
}

export function thickenDesignLines(
  canvas: HTMLCanvasElement,
  opts: ThickenDesignLinesOptions
): HTMLCanvasElement {
  const passes = Math.max(1, opts.passes ?? 1);
  const tol = opts.bgTolerance ?? 5;
  const { r: tr, g: tg, b: tb } = hexToRgb(opts.bgColor);
  const maxDistSq = (tol / 100) ** 2 * 195075;

  let imageData = canvasToImageData(canvas);
  for (let p = 0; p < passes; p++) {
    imageData = dilateOnePass(imageData, tr, tg, tb, maxDistSq);
  }
  return imageDataToCanvas(imageData);
}

function dilateOnePass(
  src: ImageData,
  tr: number,
  tg: number,
  tb: number,
  maxDistSq: number
): ImageData {
  const { width: w, height: h, data } = src;
  const out = new Uint8ClampedArray(data);

  // Classify every pixel: 1 = BG-colored, 0 = design pixel (or transparent).
  const isBg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    if (data[k + 3] === 0) {
      isBg[i] = 0; // already-transparent pixels aren't BG candidates
      continue;
    }
    const dr = data[k] - tr;
    const dg = data[k + 1] - tg;
    const db = data[k + 2] - tb;
    isBg[i] = dr * dr + dg * dg + db * db <= maxDistSq ? 1 : 0;
  }

  // For each BG pixel that 8-touches a design pixel, copy the color of the
  // neighbor that is FARTHEST from the BG color in RGB space. That neighbor
  // is the "core" stroke pixel (least anti-aliased), so the new pixel
  // inherits the saturated stroke color and the new edge is sharp rather
  // than soft.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isBg[i]) continue;

      let bestNi = -1;
      let bestDistSq = -1;
      const x0 = x > 0 ? -1 : 0;
      const x1 = x < w - 1 ? 1 : 0;
      const y0 = y > 0 ? -1 : 0;
      const y1 = y < h - 1 ? 1 : 0;
      for (let dy = y0; dy <= y1; dy++) {
        for (let dx = x0; dx <= x1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ni = i + dy * w + dx;
          if (isBg[ni]) continue;
          const nk = ni * 4;
          if (data[nk + 3] === 0) continue;
          const ndr = data[nk] - tr;
          const ndg = data[nk + 1] - tg;
          const ndb = data[nk + 2] - tb;
          const dSq = ndr * ndr + ndg * ndg + ndb * ndb;
          if (dSq > bestDistSq) {
            bestDistSq = dSq;
            bestNi = ni;
          }
        }
      }
      if (bestNi >= 0) {
        const k = i * 4;
        const nk = bestNi * 4;
        out[k] = data[nk];
        out[k + 1] = data[nk + 1];
        out[k + 2] = data[nk + 2];
        out[k + 3] = 255;
      }
    }
  }

  return new ImageData(out, w, h);
}

// ─── Magic-erase a connected region ────────────────────────────────────────
//
// User-driven companion to the flood chromakey: starting from a tap point,
// remove all opaque pixels that are connected to it AND match its color
// within tolerance. Used to delete interior shapes (e.g. a leftover white
// "speech bubble" inside an invitation) that flood-from-edges can't reach
// because they're enclosed by the design.

export interface EraseRegionOptions {
  /** Tolerance 0–100. Default 12 — tight, catches anti-alias fringe of the same shape. */
  tolerance?: number;
  /**
   * Also drop fringe pixels around the erased region whose color is close
   * to the seed color. Helps clean up anti-aliased edges of the removed
   * shape. Default 1 pixel.
   */
  fringeFeather?: number;
}

export interface EraseRegionResult {
  canvas: HTMLCanvasElement;
  pixelsErased: number;
}

export function eraseRegion(
  canvas: HTMLCanvasElement,
  seedX: number,
  seedY: number,
  opts: EraseRegionOptions = {}
): EraseRegionResult {
  const tolerance = opts.tolerance ?? 12;
  const fringeFeather = opts.fringeFeather ?? 1;
  const imageData = canvasToImageData(canvas);
  const { width: w, height: h, data } = imageData;

  // Bounds + opaque check on the seed.
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) {
    return { canvas, pixelsErased: 0 };
  }
  const seedIdx = (seedY * w + seedX) * 4;
  if (data[seedIdx + 3] === 0) {
    return { canvas, pixelsErased: 0 };
  }
  const sR = data[seedIdx];
  const sG = data[seedIdx + 1];
  const sB = data[seedIdx + 2];
  const maxDistSq = (tolerance / 100) ** 2 * 195075;

  // Flood fill from seed across pixels matching the seed color within
  // tolerance. Stack-based to avoid recursion blowups.
  const visited = new Uint8Array(w * h);
  const erased = new Uint8Array(w * h);
  const stack: number[] = [seedX, seedY];
  let pixelsErased = 0;

  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const i = y * w + x;
    if (visited[i]) continue;
    visited[i] = 1;
    const k = i * 4;
    if (data[k + 3] === 0) continue;
    const dr = data[k] - sR;
    const dg = data[k + 1] - sG;
    const db = data[k + 2] - sB;
    if (dr * dr + dg * dg + db * db > maxDistSq) continue;
    erased[i] = 1;
    data[k + 3] = 0;
    pixelsErased++;
    if (x > 0) stack.push(x - 1, y);
    if (x < w - 1) stack.push(x + 1, y);
    if (y > 0) stack.push(x, y - 1);
    if (y < h - 1) stack.push(x, y + 1);
  }

  // Optional fringe pass: dilate the erased region by `fringeFeather`
  // pixels and drop any pixel inside the dilation whose color is within
  // ~2× tolerance of the seed. Cleans the soft edge that anti-aliasing
  // leaves around the erased shape.
  if (fringeFeather > 0 && pixelsErased > 0) {
    const fringeDistSq = ((tolerance * 2) / 100) ** 2 * 195075;
    const r = Math.max(1, Math.floor(fringeFeather));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (erased[i]) continue;
        const k = i * 4;
        if (data[k + 3] === 0) continue;
        // Is any neighbor within `r` an erased pixel?
        let near = false;
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w - 1, x + r);
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);
        outer: for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            if (erased[yy * w + xx]) {
              near = true;
              break outer;
            }
          }
        }
        if (!near) continue;
        const dr = data[k] - sR;
        const dg = data[k + 1] - sG;
        const db = data[k + 2] - sB;
        if (dr * dr + dg * dg + db * db <= fringeDistSq) {
          data[k + 3] = 0;
          pixelsErased++;
        }
      }
    }
  }

  return { canvas: imageDataToCanvas(imageData), pixelsErased };
}

// ─── Edge decontamination ──────────────────────────────────────────────────
//
// After background removal, fringe pixels (opaque pixels at the boundary
// with transparent ones) usually contain a mix of true foreground color
// and bleed-through from the background. On a navy → white-text edge, the
// fringe pixels look like dirty white; on a white → light-pink-flower
// edge, the fringe looks dingy.
//
// This is the same problem Photoshop solves with "Select Color Range +
// Fill with foreground color" inside a layer mask. We automate it by
// computing the linear unmix of each fringe pixel against the BG color,
// using the design's own interior color (sampled from non-fringe opaque
// neighbors) as the foreground reference. The pixel is then either:
//
//   • snapped to the inferred foreground color at full opacity (crisp,
//     halo-free edge — like manually re-stroking text in Photoshop), OR
//   • dropped to fully transparent (when the pixel is mostly BG bleed).
//
// Iterating 2-3× handles thicker halos that are several pixels wide.

export interface DecontaminateEdgesOptions {
  /** The background color used during the chromakey pass. */
  bgColor: string;
  /**
   * Below this fraction (FG-vs-BG mix), the fringe pixel is considered
   * mostly bleed and dropped to transparent. 0..1. Default 0.35 — keeps
   * ~65 %+ true-color pixels.
   */
  dropThreshold?: number;
  /**
   * Number of decontamination passes. Each pass cleans one pixel layer
   * deeper into the fringe. Default 2.
   */
  iterations?: number;
  /**
   * Search radius for sampling the inner foreground color. Larger radius
   * helps isolated thin features (script text) find their own interior
   * color. Default 3.
   */
  innerSearchRadius?: number;
}

export function decontaminateEdges(
  canvas: HTMLCanvasElement,
  opts: DecontaminateEdgesOptions
): HTMLCanvasElement {
  const iterations = opts.iterations ?? 2;
  const dropThreshold = opts.dropThreshold ?? 0.35;
  const innerR = opts.innerSearchRadius ?? 3;
  const { r: bgR, g: bgG, b: bgB } = hexToRgb(opts.bgColor);

  let imageData = canvasToImageData(canvas);

  for (let iter = 0; iter < iterations; iter++) {
    const { width: w, height: h, data } = imageData;
    const out = new Uint8ClampedArray(data);

    // Pass 1: build alpha + fringe masks.
    const opaque = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) opaque[i] = data[i * 4 + 3] === 255 ? 1 : 0;

    const fringe = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!opaque[i]) continue;
        // Is any 4-neighbor transparent?
        if (
          (x > 0 && !opaque[i - 1]) ||
          (x < w - 1 && !opaque[i + 1]) ||
          (y > 0 && !opaque[i - w]) ||
          (y < h - 1 && !opaque[i + w])
        ) {
          fringe[i] = 1;
        }
      }
    }

    // Pass 2: for each fringe pixel, compute inner FG color and unmix.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!fringe[i]) continue;

        // Sample interior (opaque, non-fringe) pixels within innerR.
        let sR = 0;
        let sG = 0;
        let sB = 0;
        let n = 0;
        const x0 = Math.max(0, x - innerR);
        const x1 = Math.min(w - 1, x + innerR);
        const y0 = Math.max(0, y - innerR);
        const y1 = Math.min(h - 1, y + innerR);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const j = yy * w + xx;
            if (!opaque[j] || fringe[j]) continue;
            const k = j * 4;
            sR += data[k];
            sG += data[k + 1];
            sB += data[k + 2];
            n++;
          }
        }
        // No interior neighbor? Skip — pixel is part of an isolated thin
        // feature and our unmix would be unreliable. Leave it as-is.
        if (n === 0) continue;

        const fgR = sR / n;
        const fgG = sG / n;
        const fgB = sB / n;

        // Linear unmix: t = ((P - BG) · (FG - BG)) / ||FG - BG||²
        const idx = i * 4;
        const dRfg = fgR - bgR;
        const dGfg = fgG - bgG;
        const dBfg = fgB - bgB;
        const denom = dRfg * dRfg + dGfg * dGfg + dBfg * dBfg;
        // FG indistinguishable from BG → can't decontaminate; leave alone.
        if (denom < 8) continue;

        const dRpx = data[idx] - bgR;
        const dGpx = data[idx + 1] - bgG;
        const dBpx = data[idx + 2] - bgB;
        let t = (dRpx * dRfg + dGpx * dGfg + dBpx * dBfg) / denom;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;

        if (t < dropThreshold) {
          out[idx + 3] = 0;
        } else {
          out[idx] = Math.round(fgR);
          out[idx + 1] = Math.round(fgG);
          out[idx + 2] = Math.round(fgB);
          out[idx + 3] = 255;
        }
      }
    }

    imageData = new ImageData(out, w, h);
  }

  return imageDataToCanvas(imageData);
}

/**
 * Feather alpha edges by averaging alpha within a small radius. Very light
 * box blur applied only to the alpha channel for clean anti-aliased cutouts.
 */
function featherAlpha(imageData: ImageData, radius: number) {
  if (radius <= 0) return;
  const { width, height, data } = imageData;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = data[i * 4 + 3];

  const out = new Uint8Array(width * height);
  const r = Math.round(radius);
  const denom = (2 * r + 1) * (2 * r + 1);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const sx = Math.max(0, Math.min(width - 1, x + dx));
          const sy = Math.max(0, Math.min(height - 1, y + dy));
          sum += alpha[sy * width + sx];
        }
      }
      out[y * width + x] = Math.round(sum / denom);
    }
  }

  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = out[i];
  }
}
