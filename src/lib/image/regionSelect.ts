/**
 * Click-to-grow region selector. User taps a pixel inside a design
 * element (a flower, the dress, a letter); the tool floods outward
 * from the tap, adding any neighbouring pixel that:
 *
 *   1. Is COLOUR-SIMILAR to the tap pixel (within `colorTolerance`),
 *   2. Is NOT separated from the current frontier by a strong edge
 *      (uses the same edge-cost map the magnetic lasso uses).
 *
 * The combined criterion is what makes this tool intuitive on
 * intricate invitations: a click on a pink rose grows to the whole
 * rose but stops at the gold leaf adjacent to it, even though both
 * happen to share some colours, because the edge between them is
 * sharp.
 *
 * Multiple taps grow MORE region (additive). Hold-shift-tap subtracts
 * (the UI layer handles the modifier — this lib just returns a mask).
 *
 * Returns a Uint8Array bitmask the same size as the source canvas:
 * 1 = selected, 0 = not.
 */

import { canvasToImageData } from "./canvas";

export interface ClickGrowOptions {
  /** RGB tolerance for "similar enough" neighbour. Default 28 — about
   *  one full anti-alias step. */
  colorTolerance?: number;
  /** Edge cost above which the flood refuses to cross. Default 0.55 —
   *  matches the magnetic-lasso's "strong edge" definition. Lower =
   *  more aggressive about stopping at edges; higher = will leak
   *  through soft edges. */
  edgeStop?: number;
  /** Cap on how many pixels the flood will visit (safety). Default
   *  effectively unlimited (full image). */
  maxPixels?: number;
}

/**
 * Run a single click-to-grow flood from (x, y). Pass an existing mask
 * to add to it (additive selection); pass `null` to start fresh.
 */
export function clickToGrow(
  canvas: HTMLCanvasElement,
  edgeMap: Float32Array,
  x: number,
  y: number,
  existingMask: Uint8Array | null,
  opts: ClickGrowOptions = {}
): Uint8Array {
  const tol = opts.colorTolerance ?? 28;
  const tolSq = tol * tol;
  const edgeStop = opts.edgeStop ?? 0.55;
  const imageData = canvasToImageData(canvas);
  const { data, width: w, height: h } = imageData;
  const N = w * h;
  const maxPx = opts.maxPixels ?? N;

  const mask = existingMask ? new Uint8Array(existingMask) : new Uint8Array(N);

  const startIdx = y * w + x;
  if (startIdx < 0 || startIdx >= N) return mask;
  if (mask[startIdx] === 1) return mask; // already selected; no-op

  const k0 = startIdx * 4;
  const r0 = data[k0];
  const g0 = data[k0 + 1];
  const b0 = data[k0 + 2];
  const a0 = data[k0 + 3];
  // Don't grow from a transparent pixel — there's nothing meaningful
  // to flood through.
  if (a0 === 0) return mask;

  // Edge-cost stop value: edgeMap is in [0.05, 1] where LOW = strong
  // edge. We refuse to step into a pixel whose edge cost is BELOW
  // (1 - edgeStop) — i.e. a pixel that the lasso would happily snap to.
  const edgeCutoff = 1 - edgeStop;

  // Visited tracking — separate from `mask` so we don't re-process
  // pixels we've already considered (and rejected).
  const visited = new Uint8Array(N);
  visited[startIdx] = 1;
  mask[startIdx] = 1;
  let added = 1;

  // Simple ring-buffer queue (avoids Array.shift O(n) cost).
  const queueCap = N;
  const queue = new Int32Array(queueCap);
  let qHead = 0;
  let qTail = 0;
  queue[qTail++] = startIdx;

  while (qHead < qTail && added < maxPx) {
    const idx = queue[qHead++];
    const ux = idx % w;
    const uy = (idx / w) | 0;

    // 4-connected (cardinal). 8-connected leaks across diagonal corners
    // of letter stems / fine details much too easily.
    for (let n = 0; n < 4; n++) {
      const nx = ux + (n === 0 ? 1 : n === 1 ? -1 : 0);
      const ny = uy + (n === 2 ? 1 : n === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      const nk = ni * 4;
      // Stop at transparent pixels too — they're outside any element.
      if (data[nk + 3] === 0) continue;
      const dr = data[nk] - r0;
      const dg = data[nk + 1] - g0;
      const db = data[nk + 2] - b0;
      if (dr * dr + dg * dg + db * db > tolSq) continue;
      // Edge-stop: don't cross a strong edge. We check the destination
      // pixel's cost; if it's a high-strength edge pixel we won't enter it.
      if (edgeMap[ni] < edgeCutoff) continue;
      mask[ni] = 1;
      added++;
      queue[qTail++] = ni;
    }
  }
  return mask;
}

/**
 * Subtractive variant — same flood, but UNSETS bits in the mask
 * instead of setting them. Used by shift-click in the UI to "deselect
 * everything connected to this point".
 */
export function clickToShrink(
  canvas: HTMLCanvasElement,
  edgeMap: Float32Array,
  x: number,
  y: number,
  existingMask: Uint8Array,
  opts: ClickGrowOptions = {}
): Uint8Array {
  // Run the same grow but only within the existing mask, then XOR.
  const grown = clickToGrow(canvas, edgeMap, x, y, null, opts);
  const out = new Uint8Array(existingMask);
  for (let i = 0; i < out.length; i++) {
    if (grown[i] === 1) out[i] = 0;
  }
  return out;
}
