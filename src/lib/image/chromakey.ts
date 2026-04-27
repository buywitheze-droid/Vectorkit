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
