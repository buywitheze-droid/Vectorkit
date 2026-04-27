/**
 * Auto-crop fully-transparent edges from a canvas.
 *
 * Walks each edge inward until it finds a row/column with at least one
 * non-fully-transparent pixel (alpha > threshold), then crops to that bbox
 * with optional padding.
 */

import { canvasToImageData } from "./canvas";

export interface CropOptions {
  alphaThreshold?: number;
  padding?: number;
}

export function autoCropTransparent(
  canvas: HTMLCanvasElement,
  opts: CropOptions = {}
): HTMLCanvasElement {
  const { alphaThreshold = 1, padding = 0 } = opts;
  const imageData = canvasToImageData(canvas);
  const { width, height, data } = imageData;

  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  // Top
  outer: for (top = 0; top < height; top++) {
    for (let x = 0; x < width; x++) {
      if (data[(top * width + x) * 4 + 3] >= alphaThreshold) break outer;
    }
  }
  // Bottom
  outer: for (bottom = height - 1; bottom >= top; bottom--) {
    for (let x = 0; x < width; x++) {
      if (data[(bottom * width + x) * 4 + 3] >= alphaThreshold) break outer;
    }
  }
  // Left
  outer: for (left = 0; left < width; left++) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * width + left) * 4 + 3] >= alphaThreshold) break outer;
    }
  }
  // Right
  outer: for (right = width - 1; right >= left; right--) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * width + right) * 4 + 3] >= alphaThreshold) break outer;
    }
  }

  if (top > bottom || left > right) {
    // Fully transparent input: return a 1×1 transparent canvas.
    const out = document.createElement("canvas");
    out.width = 1;
    out.height = 1;
    return out;
  }

  // Apply padding (clamped to image bounds).
  top = Math.max(0, top - padding);
  left = Math.max(0, left - padding);
  bottom = Math.min(height - 1, bottom + padding);
  right = Math.min(width - 1, right + padding);

  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = cropW;
  out.height = cropH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH);
  return out;
}
