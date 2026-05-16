/**
 * Edge-aware unsharp mask for print-prep sharpening.
 *
 * Plain unsharp mask = blur the image, subtract the blur from the original,
 * scale by `amount`, add back. This boosts contrast at edges (where the
 * original differs most from its blurred version) but ALSO amplifies noise
 * in flat areas, which on photographic content (the dress fabric, soft
 * floral backgrounds) shows up as ugly grain.
 *
 * The fix: gate the sharpening by the local gradient magnitude. We only
 * apply the boost where the source has actual edge structure; flat areas
 * stay flat.
 *
 *   edge_strength(x,y) = |Sobel(x,y)|, normalised to [0,1]
 *   mask = smoothstep(threshold, threshold + softness, edge_strength)
 *   sharpened = src + mask * amount * (src - blurred)
 *
 * Tuning notes for invitation-design printing:
 *   • amount=0.4  → noticeably crisper text edges, no grain
 *   • amount=0.7  → punchy print look, mild over-sharpening at high contrast
 *   • amount=1.0+ → halos around text become visible, avoid
 */

import { canvasToImageData, imageDataToCanvas } from "./canvas";

export interface UnsharpOptions {
  /** How much to boost edge contrast. 0 = no-op, 1 = aggressive. Default 0.5. */
  amount?: number;
  /** Blur radius (pixels) for the unsharp kernel. Larger = sharpens broader
   *  features. For text, 1.0–1.5 is the sweet spot. Default 1.2. */
  radius?: number;
  /** Edge-strength gating. 0 = sharpen everywhere (plain unsharp). 0.05–0.15
   *  = sharpen only real edges (flat areas stay clean). Default 0.08. */
  edgeThreshold?: number;
}

export function edgeAwareSharpen(
  source: HTMLCanvasElement,
  opts: UnsharpOptions = {}
): HTMLCanvasElement {
  const amount = opts.amount ?? 0.5;
  const radius = opts.radius ?? 1.2;
  const edgeThr = opts.edgeThreshold ?? 0.08;
  if (amount <= 0) {
    const out = document.createElement("canvas");
    out.width = source.width;
    out.height = source.height;
    out.getContext("2d")!.drawImage(source, 0, 0);
    return out;
  }

  const img = canvasToImageData(source);
  const w = img.width;
  const h = img.height;
  const data = img.data;

  // 1. Compute a luminance-only buffer (faster gradient calculation).
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    lum[i] = data[k] * 0.299 + data[k + 1] * 0.587 + data[k + 2] * 0.114;
  }

  // 2. Sobel edge magnitude per pixel, normalised.
  const edge = new Float32Array(w * h);
  let maxEdge = 0;
  for (let y = 1; y < h - 1; y++) {
    const above = (y - 1) * w;
    const mid = y * w;
    const below = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const tl = lum[above + x - 1];
      const t = lum[above + x];
      const tr = lum[above + x + 1];
      const l = lum[mid + x - 1];
      const r = lum[mid + x + 1];
      const bl = lum[below + x - 1];
      const b = lum[below + x];
      const br = lum[below + x + 1];
      const gx = -tl - 2 * l - bl + tr + 2 * r + br;
      const gy = -tl - 2 * t - tr + bl + 2 * b + br;
      const m = Math.sqrt(gx * gx + gy * gy);
      edge[mid + x] = m;
      if (m > maxEdge) maxEdge = m;
    }
  }
  if (maxEdge > 0) {
    for (let i = 0; i < w * h; i++) edge[i] /= maxEdge;
  }

  // 3. Separable Gaussian blur of the original RGB into a Float buffer.
  // Two passes (horizontal then vertical) of a 1D kernel sized to `radius`.
  const kernelHalf = Math.max(1, Math.ceil(radius * 2));
  const kernel = buildGaussianKernel(radius, kernelHalf);
  const tmp = new Float32Array(w * h * 3);
  const blurred = new Float32Array(w * h * 3);

  // Horizontal pass: data → tmp.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let k = -kernelHalf; k <= kernelHalf; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const wk = kernel[k + kernelHalf];
        const i = (row + xx) * 4;
        r += data[i] * wk;
        g += data[i + 1] * wk;
        b += data[i + 2] * wk;
        sum += wk;
      }
      const o = (row + x) * 3;
      const inv = sum > 0 ? 1 / sum : 0;
      tmp[o] = r * inv;
      tmp[o + 1] = g * inv;
      tmp[o + 2] = b * inv;
    }
  }
  // Vertical pass: tmp → blurred.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let k = -kernelHalf; k <= kernelHalf; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const wk = kernel[k + kernelHalf];
        const i = (yy * w + x) * 3;
        r += tmp[i] * wk;
        g += tmp[i + 1] * wk;
        b += tmp[i + 2] * wk;
        sum += wk;
      }
      const o = (y * w + x) * 3;
      const inv = sum > 0 ? 1 / sum : 0;
      blurred[o] = r * inv;
      blurred[o + 1] = g * inv;
      blurred[o + 2] = b * inv;
    }
  }

  // 4. Compose: src + edgeMask * amount * (src - blurred).
  // Smoothstep on the edge map gives a clean fade-in instead of a hard
  // gate that produces "patchy" sharpening where edges flicker on/off.
  const out = new ImageData(w, h);
  const softness = 0.08;
  for (let i = 0; i < w * h; i++) {
    const k = i * 4;
    const o = i * 3;
    const e = smoothstep(edgeThr, edgeThr + softness, edge[i]);
    const boost = e * amount;
    out.data[k] = clamp255(data[k] + boost * (data[k] - blurred[o]));
    out.data[k + 1] = clamp255(data[k + 1] + boost * (data[k + 1] - blurred[o + 1]));
    out.data[k + 2] = clamp255(data[k + 2] + boost * (data[k + 2] - blurred[o + 2]));
    out.data[k + 3] = data[k + 3];
  }
  return imageDataToCanvas(out);
}

function buildGaussianKernel(sigma: number, half: number): Float32Array {
  const len = half * 2 + 1;
  const k = new Float32Array(len);
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let i = -half; i <= half; i++) {
    k[i + half] = Math.exp(-i * i * inv2s2);
  }
  return k;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (x <= edge0) return 0;
  if (x >= edge1) return 1;
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

function clamp255(v: number): number {
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return v;
}
