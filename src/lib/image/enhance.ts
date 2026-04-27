/**
 * Image enhancement utilities — colour adjustments, sharpening, auto-levels.
 *
 * Two distinct enhancement profiles:
 *  - PHOTO   → lift shadows, gentle saturation/vibrance boost, mild sharpen,
 *              optional auto-levels per channel.
 *  - GRAPHIC → punchy contrast, strong vibrance, stronger edge sharpen,
 *              alpha edge cleanup so cutouts print crisp.
 *
 * Everything operates on ImageData in pure JS — runs anywhere a browser
 * canvas runs. No external deps.
 */

import { canvasToImageData, imageDataToCanvas } from "./canvas";

export interface PhotoAdjustments {
  brightness: number;   // -100 .. +100
  contrast: number;     // -100 .. +100
  saturation: number;   // -100 .. +100
  vibrance: number;     // -100 .. +100  (smarter than saturation; preserves skin)
  sharpen: number;      //   0 .. 100
  shadows: number;      // -100 .. +100  (lift dark pixels)
  highlights: number;   // -100 .. +100  (recover bright pixels)
  warmth: number;       // -100 .. +100  (cooler / warmer color cast)
  autoLevels: boolean;  // stretch histogram per channel before adjustments
}

export interface GraphicAdjustments {
  contrast: number;     // -100 .. +100  (default boost)
  vibrance: number;     // -100 .. +100
  sharpen: number;      //   0 .. 100
  edgeCleanup: number;  //   0 .. 100  (alpha threshold + light blur cleanup)
}

export const PHOTO_AUTO_PRESET: PhotoAdjustments = {
  brightness: 5,
  contrast: 12,
  saturation: 8,
  vibrance: 18,
  sharpen: 25,
  shadows: 18,
  highlights: -10,
  warmth: 4,
  autoLevels: true,
};

export const GRAPHIC_AUTO_PRESET: GraphicAdjustments = {
  contrast: 15,
  vibrance: 25,
  sharpen: 35,
  edgeCleanup: 20,
};

export const PHOTO_NEUTRAL: PhotoAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  sharpen: 0,
  shadows: 0,
  highlights: 0,
  warmth: 0,
  autoLevels: false,
};

export const GRAPHIC_NEUTRAL: GraphicAdjustments = {
  contrast: 0,
  vibrance: 0,
  sharpen: 0,
  edgeCleanup: 0,
};

// ─── Public API ─────────────────────────────────────────────────────────────

export function enhancePhoto(
  source: HTMLCanvasElement,
  adj: PhotoAdjustments
): HTMLCanvasElement {
  const imageData = canvasToImageData(source);
  if (adj.autoLevels) applyAutoLevels(imageData);
  applyShadowHighlight(imageData, adj.shadows, adj.highlights);
  applyWarmth(imageData, adj.warmth);
  applyBrightnessContrast(imageData, adj.brightness, adj.contrast);
  applySaturation(imageData, adj.saturation);
  applyVibrance(imageData, adj.vibrance);
  let canvas = imageDataToCanvas(imageData);
  if (adj.sharpen > 0) canvas = applySharpen(canvas, adj.sharpen / 100);
  return canvas;
}

export function enhanceGraphic(
  source: HTMLCanvasElement,
  adj: GraphicAdjustments
): HTMLCanvasElement {
  const imageData = canvasToImageData(source);
  applyBrightnessContrast(imageData, 0, adj.contrast);
  applyVibrance(imageData, adj.vibrance);
  if (adj.edgeCleanup > 0) cleanAlphaEdges(imageData, adj.edgeCleanup / 100);
  let canvas = imageDataToCanvas(imageData);
  if (adj.sharpen > 0) canvas = applySharpen(canvas, adj.sharpen / 100);
  return canvas;
}

// ─── Pixel-level adjustments ────────────────────────────────────────────────

/** Brightness ±100 → ±100 raw value added; Contrast ±100 → factor 0..2 around 128. */
function applyBrightnessContrast(
  imageData: ImageData,
  brightness: number,
  contrast: number
) {
  if (brightness === 0 && contrast === 0) return;
  const data = imageData.data;
  const b = brightness * 1.275; // ±100 → ±~127.5
  // Standard contrast formula: ((c + 100) / 100)^2
  const cFactor = ((contrast + 100) / 100) ** 2;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = data[i + c] + b;
      v = (v - 128) * cFactor + 128;
      data[i + c] = clamp255(v);
    }
  }
}

function applySaturation(imageData: ImageData, saturation: number) {
  if (saturation === 0) return;
  const data = imageData.data;
  const s = 1 + saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = clamp255(lum + (r - lum) * s);
    data[i + 1] = clamp255(lum + (g - lum) * s);
    data[i + 2] = clamp255(lum + (b - lum) * s);
  }
}

/**
 * Vibrance: like saturation but boosts less-saturated pixels more. Preserves
 * already-vivid colors and protects skin tones.
 */
function applyVibrance(imageData: ImageData, vibrance: number) {
  if (vibrance === 0) return;
  const data = imageData.data;
  const v = vibrance / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max; // 0..1
    // Boost is stronger for lower saturation; 1 - sat curves the effect.
    const factor = 1 + v * (1 - sat);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = clamp255(lum + (r - lum) * factor);
    data[i + 1] = clamp255(lum + (g - lum) * factor);
    data[i + 2] = clamp255(lum + (b - lum) * factor);
  }
}

/**
 * Shadow / highlight recovery using a soft luminance-weighted curve.
 * shadows  > 0 → lift dark pixels (recover detail)
 * highlights < 0 → pull bright pixels down
 */
function applyShadowHighlight(
  imageData: ImageData,
  shadows: number,
  highlights: number
) {
  if (shadows === 0 && highlights === 0) return;
  const data = imageData.data;
  const sStrength = shadows / 100;
  const hStrength = highlights / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; // 0..1

    // Shadow mask: 1 when dark, 0 when bright (smooth falloff)
    const shadowMask = Math.pow(1 - lum, 2);
    // Highlight mask: 1 when bright, 0 when dark
    const highlightMask = Math.pow(lum, 2);

    const shift = sStrength * 90 * shadowMask + hStrength * 90 * highlightMask;

    data[i] = clamp255(r + shift);
    data[i + 1] = clamp255(g + shift);
    data[i + 2] = clamp255(b + shift);
  }
}

/** Warmth: positive shifts toward orange (more R, less B); negative toward blue. */
function applyWarmth(imageData: ImageData, warmth: number) {
  if (warmth === 0) return;
  const data = imageData.data;
  const w = warmth / 100;
  const rShift = w * 25;
  const bShift = -w * 25;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp255(data[i] + rShift);
    data[i + 2] = clamp255(data[i + 2] + bShift);
  }
}

/**
 * Auto-levels: stretch each channel's histogram so darkest pixel = 0 and
 * brightest = 255. Uses 0.5% percentile clipping to ignore outliers.
 */
function applyAutoLevels(imageData: ImageData) {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const clipCount = Math.max(1, Math.round(totalPixels * 0.005));

  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < data.length; i += 4) hist[data[i]]++;

    let lo = 0;
    let count = 0;
    while (lo < 255 && count + hist[lo] < clipCount) {
      count += hist[lo];
      lo++;
    }
    let hi = 255;
    count = 0;
    while (hi > 0 && count + hist[hi] < clipCount) {
      count += hist[hi];
      hi--;
    }
    if (hi <= lo) continue;
    const scale = 255 / (hi - lo);
    for (let i = c; i < data.length; i += 4) {
      data[i] = clamp255((data[i] - lo) * scale);
    }
  }
}

/**
 * Unsharp-mask style sharpen: blur a copy, subtract from original to find
 * edges, add weighted edges back.
 */
function applySharpen(canvas: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;
  const original = ctx.getImageData(0, 0, w, h);

  // 3x3 sharpen kernel weighted by amount
  const center = 1 + 4 * amount;
  const side = -amount;
  const kernel = [0, side, 0, side, center, side, 0, side, 0];

  const out = new ImageData(w, h);
  applyConvolution(original, out, kernel, 3);

  ctx.putImageData(out, 0, 0);
  return canvas;
}

function applyConvolution(
  src: ImageData,
  dst: ImageData,
  kernel: number[],
  size: number
) {
  const { width, height, data } = src;
  const out = dst.data;
  const half = Math.floor(size / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < size; ky++) {
        for (let kx = 0; kx < size; kx++) {
          const sx = Math.max(0, Math.min(width - 1, x + kx - half));
          const sy = Math.max(0, Math.min(height - 1, y + ky - half));
          const idx = (sy * width + sx) * 4;
          const k = kernel[ky * size + kx];
          r += data[idx] * k;
          g += data[idx + 1] * k;
          b += data[idx + 2] * k;
        }
      }
      const di = (y * width + x) * 4;
      out[di] = clamp255(r);
      out[di + 1] = clamp255(g);
      out[di + 2] = clamp255(b);
      out[di + 3] = data[di + 3];
    }
  }
}

/**
 * Clean alpha edges by pushing partial-alpha pixels to fully-on or fully-off
 * around a midpoint. Reduces the "fringe" effect on transparent cutouts —
 * critical for crisp DTF prints.
 */
function cleanAlphaEdges(imageData: ImageData, strength: number) {
  if (strength <= 0) return;
  const data = imageData.data;
  // Strength 0..1 → midpoint shift. At full strength we threshold hard at 128.
  const lower = 32 + strength * 64;   // pixels below → 0
  const upper = 224 - strength * 64;  // pixels above → 255
  // Linear ramp inside [lower..upper], saturated outside.
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a <= lower) data[i] = 0;
    else if (a >= upper) data[i] = 255;
    else data[i] = Math.round(((a - lower) / (upper - lower)) * 255);
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
