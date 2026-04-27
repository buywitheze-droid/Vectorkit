/**
 * Compositing & color effects:
 *   - Drop shadow (cast shadow behind a transparent design)
 *   - Outline / stroke (colored ring around a cutout)
 *   - Color replace (recolor a specific color region)
 *   - Despill (remove green/blue/etc. spill from edge pixels after BG removal)
 *   - Grayscale, sepia, invert
 *   - Flatten background (composite onto a solid color)
 */

import {
  canvasToImageData,
  hexToRgb,
  imageDataToCanvas,
} from "./canvas";

// ─── Drop shadow ────────────────────────────────────────────────────────────

export interface DropShadowOptions {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  opacity: number; // 0..1
}

export function dropShadow(
  canvas: HTMLCanvasElement,
  opts: DropShadowOptions
): HTMLCanvasElement {
  const padX = Math.ceil(Math.abs(opts.offsetX) + opts.blur * 2);
  const padY = Math.ceil(Math.abs(opts.offsetY) + opts.blur * 2);
  const out = document.createElement("canvas");
  out.width = canvas.width + padX * 2;
  out.height = canvas.height + padY * 2;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  const { r, g, b } = hexToRgb(opts.color);
  // Use canvas shadow* properties — drawImage casts the shadow automatically.
  ctx.save();
  ctx.shadowOffsetX = opts.offsetX;
  ctx.shadowOffsetY = opts.offsetY;
  ctx.shadowBlur = opts.blur;
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${opts.opacity})`;
  ctx.drawImage(canvas, padX, padY);
  ctx.restore();
  return out;
}

// ─── Outline / stroke ──────────────────────────────────────────────────────

export interface OutlineOptions {
  width: number;
  color: string;
  /** Render style: solid ring, or gap between original and ring. */
  style?: "solid" | "halo";
}

/**
 * Add a colored outline around the alpha shape. Implemented by dilating the
 * alpha mask (via horizontal+vertical max filter) and tinting the new ring
 * with the chosen color.
 */
export function outline(
  canvas: HTMLCanvasElement,
  opts: OutlineOptions
): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const r = Math.max(1, Math.floor(opts.width));
  const W = w + r * 2;
  const H = h + r * 2;

  // Build padded alpha array and dilate.
  const padded = new Uint8Array(W * H);
  const ctxIn = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctxIn) throw new Error("Could not get 2D context");
  const srcData = ctxIn.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      padded[(y + r) * W + (x + r)] = srcData[(y * w + x) * 4 + 3];
    }
  }
  const dilated = dilateAlpha(padded, W, H, r);

  // Render: tint dilated alpha with outline color, then draw original on top.
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  const { r: cr, g: cg, b: cb } = hexToRgb(opts.color);
  const ringData = ctx.createImageData(W, H);
  for (let i = 0; i < dilated.length; i++) {
    ringData.data[i * 4] = cr;
    ringData.data[i * 4 + 1] = cg;
    ringData.data[i * 4 + 2] = cb;
    ringData.data[i * 4 + 3] = dilated[i];
  }
  ctx.putImageData(ringData, 0, 0);
  ctx.drawImage(canvas, r, r);
  return out;
}

function dilateAlpha(
  src: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const r = Math.floor(radius);
  const temp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let max = 0;
      for (let dx = -r; dx <= r; dx++) {
        const sx = x + dx < 0 ? 0 : x + dx >= width ? width - 1 : x + dx;
        const a = src[y * width + sx];
        if (a > max) max = a;
        if (max === 255) break;
      }
      temp[y * width + x] = max;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let max = 0;
      for (let dy = -r; dy <= r; dy++) {
        const sy = y + dy < 0 ? 0 : y + dy >= height ? height - 1 : y + dy;
        const a = temp[sy * width + x];
        if (a > max) max = a;
        if (max === 255) break;
      }
      out[y * width + x] = max;
    }
  }
  return out;
}

// ─── Despill ────────────────────────────────────────────────────────────────

/**
 * Remove color spill from semi-transparent edge pixels.
 *
 * After removing a green background, edge pixels often retain a green tint
 * because they were anti-aliased against the green. This function detects
 * such pixels (alpha < 255) and reduces the spill channel toward the average
 * of the other two channels.
 */
export function despill(
  canvas: HTMLCanvasElement,
  removedColor: string
): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  const { r: rr, g: rg, b: rb } = hexToRgb(removedColor);

  // Determine spill channel: whichever channel is dominant in the removed color.
  const spillChannel: 0 | 1 | 2 =
    rr > rg && rr > rb ? 0 : rg > rr && rg > rb ? 1 : rb > rr && rb > rg ? 2 : 1;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255) continue; // edges only
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (spillChannel === 1 && g > Math.max(r, b)) {
      data[i + 1] = Math.max(r, b);
    } else if (spillChannel === 2 && b > Math.max(r, g)) {
      data[i + 2] = Math.max(r, g);
    } else if (spillChannel === 0 && r > Math.max(g, b)) {
      data[i] = Math.max(g, b);
    }
  }
  return imageDataToCanvas(imageData);
}

// ─── Color replacement ─────────────────────────────────────────────────────

export interface ColorReplaceOptions {
  fromColor: string;
  toColor: string;
  /** 0..100 — how far from the source color to consider a match. */
  tolerance: number;
  /** Preserve relative brightness of replaced pixels (recommended). */
  preserveLuma: boolean;
}

/**
 * Replace a color with another. With `preserveLuma`, shades and highlights
 * of the original color are mapped to corresponding shades of the new color
 * so a colored shirt with shadows still looks shaded after recoloring.
 */
export function replaceColor(
  canvas: HTMLCanvasElement,
  opts: ColorReplaceOptions
): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  const from = hexToRgb(opts.fromColor);
  const to = hexToRgb(opts.toColor);
  const maxDistSq = (opts.tolerance / 100) ** 2 * 195075;

  const fromLuma = 0.2126 * from.r + 0.7152 * from.g + 0.0722 * from.b;
  const toLuma = 0.2126 * to.r + 0.7152 * to.g + 0.0722 * to.b;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const dr = data[i] - from.r;
    const dg = data[i + 1] - from.g;
    const db = data[i + 2] - from.b;
    const dSq = dr * dr + dg * dg + db * db;
    if (dSq > maxDistSq) continue;

    if (opts.preserveLuma) {
      const px = data[i];
      const py = data[i + 1];
      const pz = data[i + 2];
      const pixelLuma = 0.2126 * px + 0.7152 * py + 0.0722 * pz;
      // Shift target color by (pixelLuma - fromLuma) ratio relative to toLuma.
      const lumaShift = pixelLuma - fromLuma;
      data[i] = clamp255(to.r + lumaShift * (to.r / Math.max(1, toLuma)));
      data[i + 1] = clamp255(to.g + lumaShift * (to.g / Math.max(1, toLuma)));
      data[i + 2] = clamp255(to.b + lumaShift * (to.b / Math.max(1, toLuma)));
    } else {
      data[i] = to.r;
      data[i + 1] = to.g;
      data[i + 2] = to.b;
    }
  }
  return imageDataToCanvas(imageData);
}

// ─── Color filters ─────────────────────────────────────────────────────────

export function grayscale(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const lum = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    data[i] = data[i + 1] = data[i + 2] = lum;
  }
  return imageDataToCanvas(imageData);
}

export function invert(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  return imageDataToCanvas(imageData);
}

export function sepia(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = clamp255(r * 0.393 + g * 0.769 + b * 0.189);
    data[i + 1] = clamp255(r * 0.349 + g * 0.686 + b * 0.168);
    data[i + 2] = clamp255(r * 0.272 + g * 0.534 + b * 0.131);
  }
  return imageDataToCanvas(imageData);
}

// ─── Flatten background ─────────────────────────────────────────────────────

/** Composite the image onto a solid background color (removes transparency). */
export function flattenBackground(
  canvas: HTMLCanvasElement,
  color: string
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
