/**
 * Heuristic photo-vs-graphic detector. Samples a small grid of pixels and
 * looks at:
 *   - Color uniqueness (graphics have few colors; photos have many)
 *   - Edge variance (graphics have hard sharp edges; photos have smooth gradients)
 *   - Transparency (any meaningful transparent area → graphic)
 *
 * Runs in <5ms on a 4K image (samples ~10k pixels max).
 */

import { canvasToImageData } from "./canvas";

export type ImageType = "photo" | "graphic" | "graphic-with-transparency";

export interface DetectionResult {
  type: ImageType;
  confidence: number; // 0..1
  hasTransparency: boolean;
  uniqueColors: number; // sampled
  recommendedAction: "remove-bg-color" | "remove-bg-ai" | "ready-to-resize" | "enhance-photo";
  recommendedReason: string;
}

export function detectImageType(canvas: HTMLCanvasElement): DetectionResult {
  const { width, height } = canvas;
  const imageData = canvasToImageData(canvas);
  const data = imageData.data;

  // Sample a grid of up to ~25 000 pixels (more samples = more accurate).
  const targetSamples = 25000;
  const totalPixels = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(totalPixels / targetSamples)));

  // 5-bit-per-channel quantization (32 levels per channel = 32 768 max
  // buckets). Coarser than 8-bit but fine enough that natural photos easily
  // hit several thousand buckets, while logos stay below ~500.
  const colorBuckets = new Set<number>();
  let transparentPixels = 0;
  let sampledPixels = 0;
  let edgeStrengthSum = 0;
  let edgeSamples = 0;
  // Track histogram tails — gradient-like images have non-zero entries spread
  // across the full luma range (0..255).
  const lumaHist = new Uint32Array(32);

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      sampledPixels++;
      if (a < 250) transparentPixels++;

      const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      colorBuckets.add(bucket);

      lumaHist[Math.min(31, (0.299 * r + 0.587 * g + 0.114 * b) >> 3)]++;

      if (x + step < width) {
        const ni = (y * width + (x + step)) * 4;
        const dr = data[ni] - r;
        const dg = data[ni + 1] - g;
        const db = data[ni + 2] - b;
        edgeStrengthSum += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        edgeSamples++;
      }
    }
  }

  const uniqueColors = colorBuckets.size;
  const hasTransparency = transparentPixels / sampledPixels > 0.05;
  const avgEdgeStrength = edgeStrengthSum / Math.max(1, edgeSamples);

  // Number of luma bins that contain at least 0.5% of samples — gradient
  // photos hit most bins, logos hit only a few.
  const minBinSamples = sampledPixels * 0.005;
  let activeLumaBins = 0;
  for (let i = 0; i < lumaHist.length; i++) {
    if (lumaHist[i] >= minBinSamples) activeLumaBins++;
  }

  // Heuristic combining color richness, edge softness, luma spread.
  //  - logo / flat graphic: few colors, sharp edges, few luma bins
  //  - photo: many colors, smooth edges (low avg strength because most
  //    neighboring pixels differ by single digits), many luma bins
  let isGraphic: boolean;
  if (hasTransparency) {
    // Has a real transparent area — almost certainly a graphic / cutout.
    isGraphic = true;
  } else if (uniqueColors < 250 && activeLumaBins < 10) {
    isGraphic = true; // strong logo signal
  } else if (uniqueColors < 1500 && avgEdgeStrength > 80) {
    isGraphic = true; // sharp bimodal edges (logos with anti-alias)
  } else if (uniqueColors < 800 && activeLumaBins < 12) {
    isGraphic = true; // moderate logo signal
  } else {
    isGraphic = false; // assume photo
  }

  let type: ImageType;
  if (isGraphic && hasTransparency) type = "graphic-with-transparency";
  else if (isGraphic) type = "graphic";
  else type = "photo";

  const confidence = Math.min(
    1,
    Math.abs(1500 - uniqueColors) / 1500 + (hasTransparency ? 0.2 : 0)
  );

  let recommendedAction: DetectionResult["recommendedAction"];
  let recommendedReason: string;

  if (type === "graphic-with-transparency") {
    recommendedAction = "ready-to-resize";
    recommendedReason =
      "This design already has a transparent background. Skip removal and resize it for print.";
  } else if (type === "graphic") {
    recommendedAction = "remove-bg-color";
    recommendedReason =
      "Looks like a logo or graphic. Use color-based removal — fast and precise on solid backgrounds.";
  } else {
    recommendedAction = "remove-bg-ai";
    recommendedReason =
      "Looks like a photograph. Use AI background removal — it handles complex subjects automatically.";
  }

  return {
    type,
    confidence,
    hasTransparency,
    uniqueColors,
    recommendedAction,
    recommendedReason,
  };
}
