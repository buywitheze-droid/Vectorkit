/**
 * Text layer types and helpers shared by the editor UI and the print
 * render pipeline.
 *
 * A text layer is a single piece of overlay text positioned in
 * SOURCE-CANVAS coordinates. By keeping the model in source coords:
 *
 *   • The same model can be rendered live in the editor (where we apply
 *     the viewport transform) AND on the final print canvas (where we
 *     scale up to target dimensions).
 *   • Resizing or upscaling the underlying image just changes the
 *     scale factor — text positions/sizes stay correct relative to the
 *     design without needing a re-anchor pass.
 *
 * Coordinates: `(x, y)` is the ANCHOR point (the dot the text rotates
 * around and that the alignment hangs off). The anchor's relationship
 * to the rendered text bounding box depends on `align`:
 *
 *     align = "left"   → anchor at left baseline
 *     align = "center" → anchor at center of horizontal extent, baseline
 *     align = "right"  → anchor at right baseline
 *
 * The renderer always uses `textBaseline = "alphabetic"` so the
 * baseline is the visual one designers expect.
 */

export interface TextLayer {
  /** Stable id for React keys + selection tracking. */
  id: string;
  /** The displayed text. Single line for v1 — multi-line is a stretch
   *  goal; if the user wants stacked lines they can use multiple
   *  layers stacked vertically (which gives them per-line position
   *  control, useful for invitations). */
  text: string;
  /** Font registry id (from FONT_REGISTRY). Resolved at render time
   *  via getFont() so we can change a font's family string without
   *  invalidating saved layers. */
  fontId: string;
  /** Font weight (must be one of the weights bundled for that font). */
  weight: number;
  /** True italic — only meaningful when the font has hasItalic = true. */
  italic: boolean;
  /** Font size in SOURCE-CANVAS pixels. Set on creation from the
   *  font's `defaultSizeFactor * canvas.height` and adjustable from
   *  the inspector. */
  size: number;
  /** Hex color (e.g. "#b8956a"). The user picks from a swatch palette
   *  with common invitation colours (gold, rose gold, sage, navy)
   *  plus a custom picker. */
  color: string;
  /** Horizontal alignment relative to the anchor. */
  align: "left" | "center" | "right";
  /** Anchor x in source-canvas pixels. */
  x: number;
  /** Anchor y in source-canvas pixels (baseline). */
  y: number;
  /** Rotation in radians, around the anchor. Positive = clockwise (to
   *  match CSS `transform: rotate(deg)` convention). */
  rotation: number;
  /** Letter spacing in pixels (source-canvas units). Useful to recreate
   *  the wide-tracked Trajan caps look ("Q U I N C E A Ñ E R A"). */
  letterSpacing: number;
}

/** Shape of the partial-update calls made by the inspector. Only the
 *  fields the user is editing get sent — keeps the reducer simple. */
export type TextLayerPatch = Partial<Omit<TextLayer, "id">>;

let _nextId = 1;
export function newTextLayerId(): string {
  return `t${Date.now().toString(36)}_${(_nextId++).toString(36)}`;
}

/**
 * Convenience: assemble a `ctx.font` / CSS `font` shorthand from a
 * layer's typographic settings + an explicit size (in whatever pixel
 * space the caller is rendering in).
 *
 * Why a separate sizePx argument: the LIVE preview renders at
 * `size * viewportScale` in CSS px, while the PRINT render uses
 * `size * (target/source)` in canvas px. Both need the same family /
 * weight / italic — only the size differs. Letting the caller pass it
 * keeps this function pure and reusable.
 */
export function fontShorthand(
  layer: TextLayer,
  family: string,
  sizePx: number
): string {
  const style = layer.italic ? "italic" : "normal";
  return `${style} ${layer.weight} ${sizePx}px ${family}`;
}

/**
 * Common invitation colour swatches. Curated from what actually appears
 * in the user's reference designs:
 *   • Gold / rose gold / champagne — the most common decorative ink.
 *   • Dusty rose / blush — paired with floral designs.
 *   • Sage / hunter green — the green Quinceañera variant.
 *   • Navy / charcoal — formal contrast colour.
 *   • White / ivory — for designs going on dark acrylic.
 */
export const COMMON_TEXT_SWATCHES: { label: string; hex: string }[] = [
  { label: "Antique gold", hex: "#b8956a" },
  { label: "Champagne", hex: "#d4b97a" },
  { label: "Rose gold", hex: "#c08a7a" },
  { label: "Dusty rose", hex: "#c87a93" },
  { label: "Blush", hex: "#dca7b3" },
  { label: "Sage", hex: "#8aa686" },
  { label: "Hunter green", hex: "#5a7a5a" },
  { label: "Navy", hex: "#1a2a4f" },
  { label: "Charcoal", hex: "#2c2c2c" },
  { label: "Black", hex: "#000000" },
  { label: "White", hex: "#ffffff" },
  { label: "Ivory", hex: "#fbf6e8" },
];
