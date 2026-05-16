/**
 * Intelligent Scissors / Live-Wire magnetic lasso.
 *
 * Algorithm (Mortensen & Barrett, 1995):
 *   1. Build an edge-cost map: per pixel, cost ∝ 1 - |gradient|.
 *      Strong edges have LOW cost; flat areas have HIGH cost.
 *   2. From the user's most-recent waypoint, run Dijkstra outward to
 *      build a shortest-cost-path tree across the search region.
 *   3. As the cursor moves, look up the path from cursor → seed in the
 *      tree (instant — no recomputation per move).
 *   4. Path naturally snakes along the strongest visible edge, even if
 *      the user's cursor wanders — they just need to tap a few waypoints
 *      around the perimeter, the lasso does the precise tracing.
 *
 * Performance strategy:
 *   • Edge map is computed ONCE per image (cheap: ~30 ms for a 1080×1500).
 *   • Dijkstra runs ONCE per waypoint commit, over a search box bounded
 *     to the recent-cursor-travel region (typically ~400×400 = 160k px,
 *     ~80 ms). After that, path-lookups during mouse-move are O(path
 *     length) — fast enough for 60 fps.
 *
 * No model files. No network calls. 100 % deterministic.
 */

import { canvasToImageData } from "./canvas";

/**
 * Per-pixel edge-cost map. Low cost = strong edge (should follow it);
 * high cost = flat area (avoid). Values in [0, 1].
 *
 * Computed by Sobel gradient on the greyscale-converted image, then
 * inverted and normalized. We additionally floor the cost at 0.05 so
 * that the lasso doesn't completely commit to a single noisy edge — it
 * still considers cheap-but-not-zero alternative paths.
 */
export function computeEdgeMap(canvas: HTMLCanvasElement): Float32Array {
  const imageData = canvasToImageData(canvas);
  const { data, width: w, height: h } = imageData;

  // 1. Greyscale (Rec. 709 luma).
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    gray[i] = data[k] * 0.299 + data[k + 1] * 0.587 + data[k + 2] * 0.114;
  }

  // 2. Sobel X & Y → magnitude.
  const grad = new Float32Array(w * h);
  let maxGrad = 0;
  for (let y = 1; y < h - 1; y++) {
    const rowAbove = (y - 1) * w;
    const rowMid = y * w;
    const rowBelow = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[rowAbove + x - 1];
      const t = gray[rowAbove + x];
      const tr = gray[rowAbove + x + 1];
      const l = gray[rowMid + x - 1];
      const r = gray[rowMid + x + 1];
      const bl = gray[rowBelow + x - 1];
      const b = gray[rowBelow + x];
      const br = gray[rowBelow + x + 1];
      const gx = -tl - 2 * l - bl + tr + 2 * r + br;
      const gy = -tl - 2 * t - tr + bl + 2 * b + br;
      const g = Math.sqrt(gx * gx + gy * gy);
      grad[rowMid + x] = g;
      if (g > maxGrad) maxGrad = g;
    }
  }

  // 3. Normalize, invert, floor at 0.05.
  if (maxGrad === 0) {
    grad.fill(1);
    return grad;
  }
  for (let i = 0; i < w * h; i++) {
    const norm = grad[i] / maxGrad;
    // Square-root the normalized magnitude before inverting — emphasizes
    // even modest edges (gold filigree, hairline letters) that would
    // otherwise be drowned out by a few extreme-contrast pixels in the
    // image.
    grad[i] = Math.max(0.05, 1 - Math.sqrt(norm));
  }
  return grad;
}

/**
 * Min-heap of (cost, pixelIndex) tuples, encoded as parallel Float32 +
 * Int32 arrays. Hand-rolled because JS has no builtin priority queue
 * and 3rd-party heaps add weight / surface-area for a 50-line algorithm.
 */
class MinHeap {
  private costs: Float32Array;
  private idxs: Int32Array;
  private size = 0;
  constructor(capacity: number) {
    this.costs = new Float32Array(capacity);
    this.idxs = new Int32Array(capacity);
  }
  push(cost: number, idx: number) {
    let i = this.size++;
    this.costs[i] = cost;
    this.idxs[i] = idx;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }
  pop(): { cost: number; idx: number } | null {
    if (this.size === 0) return null;
    const cost = this.costs[0];
    const idx = this.idxs[0];
    this.size--;
    if (this.size > 0) {
      this.costs[0] = this.costs[this.size];
      this.idxs[0] = this.idxs[this.size];
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.size && this.costs[l] < this.costs[smallest]) smallest = l;
        if (r < this.size && this.costs[r] < this.costs[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return { cost, idx };
  }
  private swap(a: number, b: number) {
    const c = this.costs[a];
    const i = this.idxs[a];
    this.costs[a] = this.costs[b];
    this.idxs[a] = this.idxs[b];
    this.costs[b] = c;
    this.idxs[b] = i;
  }
  get length() {
    return this.size;
  }
}

/**
 * Live-wire path finder. Owns the precomputed edge map and the per-seed
 * Dijkstra state.
 *
 *   const wire = new LiveWire(edgeMap, w, h);
 *   wire.setSeed(x, y);              // user clicked here
 *   const path = wire.pathTo(cx, cy); // cursor is here; path snaps to edges
 */
export class LiveWire {
  private cost: Float32Array;
  private w: number;
  private h: number;
  private seed: number = -1;
  private prev: Int32Array | null = null;

  constructor(cost: Float32Array, w: number, h: number) {
    this.cost = cost;
    this.w = w;
    this.h = h;
  }

  setSeed(x: number, y: number) {
    this.seed = y * this.w + x;
    this.prev = null;
  }

  /**
   * Run Dijkstra from the seed over a search box that contains both the
   * seed and the target. Returns the optimal path as a list of pixel
   * coordinates from seed → target.
   *
   * If we already have a Dijkstra tree from this seed AND the target
   * is within the box we already explored, reuse it. Otherwise expand
   * the box and re-run.
   */
  pathTo(x: number, y: number): [number, number][] {
    if (this.seed < 0) return [];
    const w = this.w;
    const h = this.h;
    const target = y * w + x;
    if (target === this.seed) return [[x, y]];

    if (!this.prev || this.prev[target] === -2) {
      this.runDijkstra(x, y);
    }
    if (!this.prev || this.prev[target] === -2) return [];

    const path: [number, number][] = [];
    let cur = target;
    let safety = w * h;
    while (cur !== this.seed && cur >= 0 && safety-- > 0) {
      path.push([cur % w, (cur / w) | 0]);
      cur = this.prev[cur];
    }
    if (cur === this.seed) {
      path.push([this.seed % w, (this.seed / w) | 0]);
    }
    path.reverse();
    return path;
  }

  /**
   * Fill prev[] for all pixels reachable from the seed within a search
   * box that comfortably contains both seed and (x, y). Pixels outside
   * the box are marked -2 ("not explored") so a later pathTo() with a
   * more distant target will trigger a re-run.
   */
  private runDijkstra(x: number, y: number) {
    const w = this.w;
    const h = this.h;
    const cost = this.cost;
    const seed = this.seed;
    const sx = seed % w;
    const sy = (seed / w) | 0;

    // Search box: contains seed + target with 80 px padding so the path
    // can curve outward to find a better edge. Capped at full image.
    const pad = 80;
    const minX = Math.max(0, Math.min(sx, x) - pad);
    const maxX = Math.min(w - 1, Math.max(sx, x) + pad);
    const minY = Math.max(0, Math.min(sy, y) - pad);
    const maxY = Math.min(h - 1, Math.max(sy, y) + pad);

    const N = w * h;
    const dist = new Float32Array(N);
    const prev = new Int32Array(N);
    // Sentinels: Infinity = unvisited & unbounded; -2 = outside box.
    dist.fill(Infinity);
    prev.fill(-2);
    for (let yy = minY; yy <= maxY; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        prev[yy * w + xx] = -1;
      }
    }
    dist[seed] = 0;
    prev[seed] = seed;

    const heap = new MinHeap(N);
    heap.push(0, seed);

    // 8-connected neighbours; diagonals get a √2 length factor so the
    // shortest path isn't pathologically diagonal.
    const SQRT2 = Math.SQRT2;
    while (heap.length > 0) {
      const node = heap.pop()!;
      if (node.cost > dist[node.idx]) continue;
      const ux = node.idx % w;
      const uy = (node.idx / w) | 0;
      // Early stop once we've settled the target.
      if (node.idx === y * w + x) break;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = uy + dy;
        if (ny < minY || ny > maxY) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = ux + dx;
          if (nx < minX || nx > maxX) continue;
          const ni = ny * w + nx;
          const stepLen = dx !== 0 && dy !== 0 ? SQRT2 : 1;
          // Edge cost is per-pixel; the step's effective cost averages
          // the source-pixel and dest-pixel costs (so an edge between
          // two strongly-edged pixels is cheap, between flat pixels is
          // expensive).
          const stepCost = ((cost[node.idx] + cost[ni]) * 0.5) * stepLen;
          const newDist = node.cost + stepCost;
          if (newDist < dist[ni]) {
            dist[ni] = newDist;
            prev[ni] = node.idx;
            heap.push(newDist, ni);
          }
        }
      }
    }
    this.prev = prev;
  }
}

/**
 * Convert a closed polyline (≥ 3 points, last connected to first) into a
 * binary mask of size w×h: 1 inside, 0 outside. Uses standard scanline
 * fill — handles self-intersecting polygons via the even-odd rule.
 */
export function rasterizePolygonMask(
  poly: ReadonlyArray<readonly [number, number]>,
  w: number,
  h: number
): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (poly.length < 3) return mask;

  // Find Y bounds for early exit.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, py] of poly) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(h - 1, Math.ceil(maxY));

  // For each scanline, find x-coordinates where polygon edges cross it.
  // Sort, then fill between alternating pairs (even-odd rule).
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      // Edge straddles scanline?
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        xs.push(x1 + t * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k < xs.length - 1; k += 2) {
      const xStart = Math.max(0, Math.ceil(xs[k]));
      const xEnd = Math.min(w - 1, Math.floor(xs[k + 1]));
      const row = y * w;
      for (let x = xStart; x <= xEnd; x++) {
        mask[row + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Apply a binary mask to a canvas, setting alpha = 0 wherever the mask
 * is 0 (or 1, depending on `keep`). Returns a new canvas; original is
 * unchanged.
 *
 *   keep="inside"  → keep mask=1, erase mask=0  (cookie-cutter effect)
 *   keep="outside" → keep mask=0, erase mask=1  (cut a hole)
 */
export function applyMaskToCanvas(
  source: HTMLCanvasElement,
  mask: Uint8Array,
  keep: "inside" | "outside"
): HTMLCanvasElement {
  const imageData = canvasToImageData(source);
  const { data, width, height } = imageData;
  const eraseValue = keep === "inside" ? 0 : 1;
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === eraseValue) {
      data[i * 4 + 3] = 0;
    }
  }
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.putImageData(imageData, 0, 0);
  return out;
}
