/**
 * Restore design colors that were eaten by background removal.
 *
 * The use case: invitation designs commonly have thin script text, soft pink
 * flowers, light pastel dresses, or gradient gold crowns whose colors are
 * close to (or contain) the background color. Tolerance-based chromakey
 * inevitably eats parts of these.
 *
 * This module restores those pixels by:
 *   1. Looking at the ORIGINAL canvas (pre-removal).
 *   2. Finding pixels whose color matches the user-picked target.
 *   3. Restricting matches to pixels NEAR the surviving subject (so we don't
 *      restore the entire background — only the gaps around the design).
 *   4. Compositing those pixels back onto the current canvas, either as the
 *      exact picked color (great for letters → uniform crisp text) or as the
 *      original RGBA (preserves shading/gradients on dresses, flowers, etc.).
 */

import {
  canvasToImageData,
  hexToRgb,
  imageDataToCanvas,
} from "./canvas";

export type RestoreMode = "solid" | "original";

export interface RestoreColorOptions {
  /** Hex color to find in the original. */
  color: string;
  /** Color match tolerance 0..50 (% of max RGB distance). */
  tolerance: number;
  /**
   * Dilate the matched region by N pixels — recovers anti-aliased edge
   * pixels just outside the strict color match. 0..5.
   */
  padding: number;
  /**
   * Only restore pixels within N px of the existing solid subject. Prevents
   * the entire color-matching background from being restored. 0 = no limit
   * (use carefully — will fill anywhere the color matches). 0..200.
   */
  searchRadius: number;
  /**
   * "solid": every restored pixel becomes the exact picked color (clean text).
   * "original": restored pixels keep their original RGB (gradients preserved).
   */
  mode: RestoreMode;
}

export interface RestoreResult {
  canvas: HTMLCanvasElement;
  /** How many pixels were restored — useful for showing user "X pixels rescued". */
  pixelsRestored: number;
}

/**
 * Restore one color from `original` into `current`.
 *
 * Algorithm: build subject mask (alpha > 0 in current) → dilate by searchRadius
 * → for every pixel in the dilation that (a) is not already opaque in current
 * AND (b) matches the target color in original → write either the original RGBA
 * or the solid target color.
 */
export function restoreColor(
  current: HTMLCanvasElement,
  original: HTMLCanvasElement,
  opts: RestoreColorOptions
): RestoreResult {
  const w = current.width;
  const h = current.height;

  // Match dimensions if the user resized between original and now.
  const origCanvas =
    original.width === w && original.height === h
      ? original
      : scaleCanvas(original, w, h);

  const origImg = canvasToImageData(origCanvas);
  const curImg = canvasToImageData(current);
  const origData = origImg.data;
  const curData = curImg.data;

  const { r: tr, g: tg, b: tb } = hexToRgb(opts.color);
  const maxDistSq = (opts.tolerance / 100) ** 2 * 195075;

  // Build "subject" mask = where current is at least partly opaque.
  const subject = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (curData[i * 4 + 3] > 0) subject[i] = 1;
  }

  // Region of allowed restoration:
  //   searchRadius > 0 → dilate subject by that much (only fill near design)
  //   searchRadius === 0 → allow anywhere
  let allowed: Uint8Array;
  if (opts.searchRadius > 0) {
    allowed = dilateBinaryMask(subject, w, h, opts.searchRadius);
  } else {
    allowed = new Uint8Array(w * h).fill(1);
  }

  // Build color match mask from original.
  const match = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!allowed[i]) continue;
    // Skip pixels that are already fully opaque in current — leave them alone.
    if (curData[i * 4 + 3] === 255) continue;
    const idx = i * 4;
    const dr = origData[idx] - tr;
    const dg = origData[idx + 1] - tg;
    const db = origData[idx + 2] - tb;
    if (dr * dr + dg * dg + db * db <= maxDistSq) {
      match[i] = 1;
    }
  }

  // Optional small padding — recover fringe anti-alias pixels just outside
  // the strict match.
  const finalMask =
    opts.padding > 0 ? dilateBinaryMask(match, w, h, opts.padding) : match;

  // Composite.
  let restored = 0;
  for (let i = 0; i < w * h; i++) {
    if (!finalMask[i]) continue;
    if (curData[i * 4 + 3] === 255) continue;
    const idx = i * 4;
    if (opts.mode === "solid") {
      curData[idx] = tr;
      curData[idx + 1] = tg;
      curData[idx + 2] = tb;
      curData[idx + 3] = 255;
    } else {
      // Use the original pixel as-is, force opaque.
      curData[idx] = origData[idx];
      curData[idx + 1] = origData[idx + 1];
      curData[idx + 2] = origData[idx + 2];
      curData[idx + 3] = 255;
    }
    restored++;
  }

  return {
    canvas: imageDataToCanvas(curImg),
    pixelsRestored: restored,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Two-pass separable max filter on a 0/1 mask. O(W·H·R).
 * For each pixel, becomes 1 if any pixel within `radius` is 1.
 */
function dilateBinaryMask(
  src: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const r = Math.max(1, Math.floor(radius));
  const temp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  // Horizontal.
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      let hit = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      for (let sx = x0; sx <= x1; sx++) {
        if (src[rowOff + sx]) {
          hit = 1;
          break;
        }
      }
      temp[rowOff + x] = hit;
    }
  }
  // Vertical.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      for (let sy = y0; sy <= y1; sy++) {
        if (temp[sy * width + x]) {
          hit = 1;
          break;
        }
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

function scaleCanvas(
  src: HTMLCanvasElement,
  w: number,
  h: number
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return out;
}

// ─── Quick "auto" presets for common invitation parts ──────────────────────

/**
 * Common invitation-element profiles. UI exposes these as one-click buttons:
 * pick the color of the eaten part, then pick a profile and apply.
 */
export interface RepairProfile {
  id: string;
  name: string;
  description: string;
  /** Defaults to merge with user-picked color. */
  defaults: Omit<RestoreColorOptions, "color">;
}

export const REPAIR_PROFILES: RepairProfile[] = [
  {
    id: "thin-text",
    name: "Thin Text / Script",
    description:
      "Crisp, uniform letters. Restored pixels are forced to one solid color so script font edges are perfectly clean — no white halos, no fragments, no rough edges.",
    defaults: {
      tolerance: 28,
      padding: 1,
      searchRadius: 30,
      mode: "solid",
    },
  },
  {
    id: "soft-flower",
    name: "Soft Flower / Pastel",
    description:
      "Brings back light pink/peach flowers whose pastel edges got removed. Preserves original shading and gradients.",
    defaults: {
      tolerance: 18,
      padding: 2,
      searchRadius: 80,
      mode: "original",
    },
  },
  {
    id: "light-dress",
    name: "Light Dress / Subject",
    description:
      "Restores light pink / pastel dress fabric where the white-removal trimmed it. Keeps natural shading.",
    defaults: {
      tolerance: 22,
      padding: 2,
      searchRadius: 40,
      mode: "original",
    },
  },
  {
    id: "gold-crown",
    name: "Gold Crown / Metallic",
    description:
      "Brings back gold/metallic gradient elements (crown, jewelry) whose lighter highlights were removed.",
    defaults: {
      tolerance: 26,
      padding: 2,
      searchRadius: 50,
      mode: "original",
    },
  },
  {
    id: "solid-shape",
    name: "Solid Shape",
    description:
      "Restores a solid-colored shape (logo element, geometric piece) as one uniform color.",
    defaults: {
      tolerance: 20,
      padding: 1,
      searchRadius: 60,
      mode: "solid",
    },
  },
];
