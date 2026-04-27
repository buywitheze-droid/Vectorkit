/**
 * Geometric transforms + alpha-mask operations.
 *
 * Includes operations critical for DTF (Direct-to-Film) printing:
 *  - Mirror (DTF transfers print face-down → designs must be mirrored).
 *  - Hard alpha threshold (DTF prints semi-transparent pixels poorly →
 *    snapping every pixel to fully opaque OR fully transparent gives crisp,
 *    halo-free prints).
 *  - Choke (alpha erosion before threshold) eliminates the soft anti-aliased
 *    fringe left by background removal so the threshold doesn't leave halos.
 */

import { canvasToImageData, imageDataToCanvas } from "./canvas";

export function mirrorHorizontal(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

export function mirrorVertical(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.translate(0, canvas.height);
  ctx.scale(1, -1);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * Rotate by degrees (clockwise). Output canvas is sized to fit the rotated
 * bounding box. For 90 / 180 / 270 a fast path avoids interpolation.
 */
export function rotateDegrees(
  canvas: HTMLCanvasElement,
  degrees: number
): HTMLCanvasElement {
  const angle = ((degrees % 360) + 360) % 360;
  if (angle === 0) {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext("2d")!.drawImage(canvas, 0, 0);
    return out;
  }

  if (angle === 90 || angle === 180 || angle === 270) {
    return rotateOrtho(canvas, angle as 90 | 180 | 270);
  }

  const rad = (angle * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const newW = Math.ceil(canvas.width * cos + canvas.height * sin);
  const newH = Math.ceil(canvas.width * sin + canvas.height * cos);

  const out = document.createElement("canvas");
  out.width = newW;
  out.height = newH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

function rotateOrtho(
  canvas: HTMLCanvasElement,
  angle: 90 | 180 | 270
): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const out = document.createElement("canvas");
  if (angle === 180) {
    out.width = w;
    out.height = h;
  } else {
    out.width = h;
    out.height = w;
  }
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  if (angle === 90) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else if (angle === 180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  } else {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// ─── Alpha threshold ────────────────────────────────────────────────────────

export interface AlphaThresholdOptions {
  /** Alpha values >= threshold become 255, < become 0. 0–254. */
  threshold: number;
  /** Erode alpha by N pixels before thresholding to remove soft fringe halos. 0–5. */
  choke: number;
}

/**
 * Snap every pixel to fully opaque or fully transparent.
 *
 * Workflow:
 *   1. (Optional) erode alpha by `choke` pixels — kills the soft anti-aliased
 *      ring left by background removal.
 *   2. Apply hard threshold: alpha >= T → 255, else 0.
 *
 * This is the recommended final step before DTF print: every pixel either
 * prints with full ink coverage or doesn't print at all. No halos, no
 * fringes, crisp edges that look professional.
 */
export function applyAlphaThreshold(
  canvas: HTMLCanvasElement,
  opts: AlphaThresholdOptions
): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  if (opts.choke > 0) erodeAlpha(imageData, opts.choke);
  const data = imageData.data;
  const t = Math.max(1, Math.min(254, opts.threshold));
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= t ? 255 : 0;
  }
  return imageDataToCanvas(imageData);
}

/**
 * Two-pass separable alpha erosion (min filter). O(W·H·R).
 */
function erodeAlpha(imageData: ImageData, radius: number): void {
  const { width, height, data } = imageData;
  const r = Math.max(1, Math.floor(radius));
  const alphaSrc = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alphaSrc[i] = data[i * 4 + 3];

  const temp = new Uint8Array(width * height);
  // Horizontal pass: min over [-r, +r] window in x.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 255;
      for (let dx = -r; dx <= r; dx++) {
        const sx = x + dx < 0 ? 0 : x + dx >= width ? width - 1 : x + dx;
        const a = alphaSrc[y * width + sx];
        if (a < min) min = a;
        if (min === 0) break;
      }
      temp[y * width + x] = min;
    }
  }
  // Vertical pass.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 255;
      for (let dy = -r; dy <= r; dy++) {
        const sy = y + dy < 0 ? 0 : y + dy >= height ? height - 1 : y + dy;
        const a = temp[sy * width + x];
        if (a < min) min = a;
        if (min === 0) break;
      }
      data[(y * width + x) * 4 + 3] = min;
    }
  }
}

// ─── Alpha statistics (helpful for testing + UI hints) ─────────────────────

export interface AlphaStats {
  totalPixels: number;
  fullyOpaque: number;
  fullyTransparent: number;
  semiTransparent: number;
  semiTransparentPct: number;
}

export function alphaStats(canvas: HTMLCanvasElement): AlphaStats {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  let opaque = 0;
  let trans = 0;
  let semi = 0;
  const total = data.length / 4;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 0) trans++;
    else if (a === 255) opaque++;
    else semi++;
  }
  return {
    totalPixels: total,
    fullyOpaque: opaque,
    fullyTransparent: trans,
    semiTransparent: semi,
    semiTransparentPct: (semi / total) * 100,
  };
}
