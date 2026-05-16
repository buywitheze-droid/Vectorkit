/**
 * Render TextLayer overlays onto a canvas at a target resolution.
 *
 * Used by:
 *   • The print pipeline (renderForPrint) — render layers at the final
 *     target dimensions for vector-quality output.
 *   • The acrylic preview compositor — render layers at the preview
 *     resolution so the user sees their text in context.
 *
 * Coordinate model: `layers` are in SOURCE-CANVAS pixels, `target` is
 * the canvas to draw onto, and `sourceWidth/Height` describe the source
 * coordinate space. We compute the scale from source→target and apply
 * it to font size, letter spacing, and anchor position. This way one
 * set of layers correctly renders into a 1080-px preview and a 4500-px
 * print at full sharpness.
 */

import { getFont, type FontEntry } from "@/lib/fonts/registry";
import { fontShorthand, type TextLayer } from "./textLayer";

export interface RenderTextLayersOptions {
  /** Canvas to draw onto. Must be ≥ targetWidth × targetHeight. */
  target: HTMLCanvasElement;
  /** Layer model dimensions (source canvas size at the time the layers
   *  were created). */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Wait for every font referenced by `layers` to be ready, then draw
 * each layer onto `target`. Returns the canvas (same reference) so the
 * caller can chain.
 *
 * Font readiness is critical — see `ensureFontLoaded` in the registry.
 */
export async function renderTextLayers(
  layers: TextLayer[],
  options: RenderTextLayersOptions
): Promise<HTMLCanvasElement> {
  const { target, sourceWidth, sourceHeight } = options;
  if (layers.length === 0) return target;

  const ctx = target.getContext("2d");
  if (!ctx) return target;

  // Compute per-axis scale. We use the AVERAGE of x/y scale for font
  // size — text rendered onto a non-uniformly-scaled target would
  // technically need to be drawn into a transformed context, but for
  // print rendering the source/target ratio is uniform (we preserve
  // aspect on resize), so this avg is exact in practice.
  const sx = target.width / sourceWidth;
  const sy = target.height / sourceHeight;
  const sFont = (sx + sy) / 2;

  // Resolve every layer's FontEntry up front + collect promises so we
  // can wait for them in parallel.
  const resolved = layers.map((layer) => {
    const font = getFont(layer.fontId);
    return { layer, font };
  });
  const loadPromises = resolved
    .filter((r): r is { layer: TextLayer; font: FontEntry } => !!r.font)
    .map(async ({ layer, font }) => {
      const { ensureFontLoaded } = await import("@/lib/fonts/registry");
      await ensureFontLoaded(
        font,
        layer.weight,
        layer.italic,
        Math.max(16, layer.size * sFont)
      );
    });
  await Promise.all(loadPromises);

  // High-quality text rendering settings.
  ctx.imageSmoothingEnabled = true;
  ctx.textBaseline = "alphabetic";

  for (const { layer, font } of resolved) {
    if (!font) {
      console.warn(`Unknown font id: ${layer.fontId} — skipping layer`);
      continue;
    }
    if (!layer.text) continue;

    ctx.save();
    // Translate to anchor in target coords, then rotate, then draw at
    // (0,0). Rotation is around the anchor — exactly what the editor
    // shows in the live preview.
    ctx.translate(layer.x * sx, layer.y * sy);
    if (layer.rotation !== 0) ctx.rotate(layer.rotation);

    ctx.font = fontShorthand(layer, font.family, layer.size * sFont);
    ctx.fillStyle = layer.color;
    ctx.textAlign = layer.align;

    if (layer.letterSpacing && layer.letterSpacing !== 0) {
      // `letterSpacing` is supported on the 2D context in modern
      // browsers (Chromium 99+, Safari 17+). Set it before measuring
      // and drawing so both produce the spaced text.
      // We type-assert since the lib.dom.d.ts in this project may not
      // yet include the property.
      (ctx as unknown as { letterSpacing: string }).letterSpacing = `${
        layer.letterSpacing * sFont
      }px`;
    } else if ("letterSpacing" in ctx) {
      (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px";
    }

    // Single-line render. Multi-line could split on \n and offset y by
    // the font metric height — left as a v2 enhancement.
    ctx.fillText(layer.text, 0, 0);
    ctx.restore();
  }

  return target;
}

/**
 * Measure the bounding rectangle of a layer in SOURCE-CANVAS pixels.
 * Used by the editor for hit-testing (clicking on a layer to select)
 * and for showing selection outlines.
 *
 * Uses an offscreen canvas to call `measureText` with the same font
 * spec we'd render with. Note: the metrics are returned in source
 * pixels (we measure at `layer.size` directly, no scale factor).
 */
export function measureTextLayer(layer: TextLayer): {
  width: number;
  height: number;
  /** Offset from anchor X to the LEFT edge of the rendered glyph run,
   *  honouring `align`. */
  offsetX: number;
  /** Offset from anchor Y (baseline) to the TOP edge of the glyphs.
   *  Always negative since the top is above the baseline. */
  offsetY: number;
} {
  const font = getFont(layer.fontId);
  if (!font || typeof document === "undefined") {
    // SSR safety — return a placeholder; the editor only hit-tests on
    // the client where this branch is never taken.
    return { width: 0, height: 0, offsetX: 0, offsetY: 0 };
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { width: 0, height: 0, offsetX: 0, offsetY: 0 };

  ctx.font = fontShorthand(layer, font.family, layer.size);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = layer.align;
  if (layer.letterSpacing && "letterSpacing" in ctx) {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${layer.letterSpacing}px`;
  }
  const m = ctx.measureText(layer.text || " ");
  // Width: horizontal extent from left to right of the rendered text.
  const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
  // Height: ascent + descent from the baseline.
  const ascent = m.actualBoundingBoxAscent;
  const descent = m.actualBoundingBoxDescent;
  const height = ascent + descent;

  // Offset from anchor X to LEFT edge of glyphs depends on align.
  let offsetX = 0;
  if (layer.align === "left") offsetX = -m.actualBoundingBoxLeft;
  else if (layer.align === "right") offsetX = -width + m.actualBoundingBoxRight;
  else /* center */ offsetX = -width / 2 + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 - m.actualBoundingBoxRight + width / 2 - m.actualBoundingBoxLeft;
  // The center case simplifies but the explicit form makes the intent
  // clearer; the result is `-width/2`. Keep the simplified version:
  if (layer.align === "center") offsetX = -width / 2;

  // Offset Y: top of glyphs is `ascent` ABOVE the baseline (negative).
  const offsetY = -ascent;

  return { width, height, offsetX, offsetY };
}
