/**
 * Acrylic-print preview compositor.
 *
 * Audience: people sending designs to a UV-printed clear-acrylic shop.
 * Before they pay $30+ per piece, they want to know what the design
 * will look like ON the actual material — clear acrylic is translucent,
 * not white, so anything in the design that's WHITE or LIGHT-COLOURED
 * will basically vanish unless the printer adds an underlying white
 * ink layer.
 *
 * What this compositor renders:
 *
 *   ┌────────────────────────────────────────┐
 *   │  (warm room background)                │
 *   │   ╭──────────────────────────╮         │
 *   │   │ ░░░░░░░░░░░░░░░░░░░░░░░░ │ ← acrylic panel (translucent
 *   │   │ ░  ┌──────────────┐  ░░ │   white showing through)
 *   │   │ ░  │  the design  │  ░░ │
 *   │   │ ░  │              │  ░░ │
 *   │   │ ░  └──────────────┘  ░░ │
 *   │   │ ░░░░░░░░░░░░░░░░░░░░░░░░ │
 *   │   ╰──────────────────────────╯
 *   │         ▔▔▔▔▔▔▔▔▔▔▔▔▔        │ ← cast shadow on table
 *   └────────────────────────────────────────┘
 *
 * The "translucent acrylic" effect is achieved by:
 *   1. Drawing the room/table background (subtle wood-toned gradient).
 *   2. Drawing a SOLID-WHITE-INK underlayer (the printer adds this so
 *      the design is opaque on clear acrylic) — this is a slight inset
 *      of the design's bounding box, with rounded corners, at ~85 %
 *      opacity to suggest the off-white tone of UV white ink.
 *   3. Drawing the design itself on top.
 *   4. Adding a thin highlight ring (acrylic edge catches light).
 *   5. Casting a soft shadow below.
 *
 * If the user disables the white-underlay (via `showWhiteInk: false`)
 * the design renders directly on the translucent acrylic — showing
 * exactly what they'd get if they ordered "no white ink", which is the
 * common pitfall: light-coloured design elements disappear.
 *
 * Output is a single canvas the wizard renders into a step-4 preview.
 */

import { type RGBA } from "./canvas";

export interface AcrylicPreviewOptions {
  /** Width of the output canvas in CSS pixels. The acrylic panel is
   *  inset inside it. Default 720. */
  outputWidth?: number;
  /** Background scene tint behind the acrylic. Defaults to a warm
   *  light-wood "table top" tone. */
  backgroundTint?: RGBA;
  /** Whether to draw the white-ink underlayer. Default true. Set false
   *  to preview "no white ink" (light design elements will look ghosted). */
  showWhiteInk?: boolean;
  /** Acrylic panel rotation in degrees, for a touch of perspective.
   *  Default 0 (flat-on). */
  rotateDeg?: number;
  /** Padding (in output px) between the panel edge and the design.
   *  Default 36. */
  panelPadding?: number;
}

const DEFAULT_BG: RGBA = { r: 232, g: 220, b: 204, a: 255 };

/**
 * Render a preview of the design printed on clear acrylic.
 *
 * `design` should be a transparent-background canvas (the user's final
 * cutout). The preview will fit it into a virtual acrylic panel and
 * compose the whole scene.
 */
export function renderAcrylicPreview(
  design: HTMLCanvasElement,
  opts: AcrylicPreviewOptions = {}
): HTMLCanvasElement {
  const outW = opts.outputWidth ?? 720;
  const bg = opts.backgroundTint ?? DEFAULT_BG;
  const padding = opts.panelPadding ?? 36;
  const showInk = opts.showWhiteInk ?? true;
  const rotateDeg = opts.rotateDeg ?? 0;

  // Match output height to the design's aspect ratio plus background
  // padding (≈ 18 % top/bottom for room context).
  const designAspect = design.height / Math.max(1, design.width);
  const panelW = outW - padding * 4;
  const panelH = Math.round(panelW * designAspect);
  const outH = panelH + Math.round(panelW * 0.36); // breathing room
  const panelX = (outW - panelW) / 2;
  const panelY = (outH - panelH) / 2 - Math.round(panelW * 0.04); // slight top-bias for shadow visibility

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  // 1. Background — a soft vertical gradient with a hint of warmth
  // (suggests a wood table under warm room lighting).
  const bgGrad = ctx.createLinearGradient(0, 0, 0, outH);
  bgGrad.addColorStop(0, `rgb(${Math.min(255, bg.r + 12)}, ${Math.min(255, bg.g + 8)}, ${Math.min(255, bg.b + 4)})`);
  bgGrad.addColorStop(1, `rgb(${Math.max(0, bg.r - 18)}, ${Math.max(0, bg.g - 22)}, ${Math.max(0, bg.b - 28)})`);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, outW, outH);

  // 2. Acrylic shadow on the "table" beneath — soft elliptical blob.
  const shadowY = panelY + panelH + 14;
  const shadowGrad = ctx.createRadialGradient(
    outW / 2,
    shadowY,
    panelW * 0.08,
    outW / 2,
    shadowY,
    panelW * 0.55
  );
  shadowGrad.addColorStop(0, "rgba(20, 14, 10, 0.55)");
  shadowGrad.addColorStop(1, "rgba(20, 14, 10, 0)");
  ctx.save();
  ctx.translate(0, 0);
  ctx.scale(1, 0.18);
  ctx.fillStyle = shadowGrad;
  ctx.fillRect(0, (shadowY - panelW * 0.55) / 0.18, outW, panelW * 1.2);
  ctx.restore();

  // 3. Acrylic panel — translucent. We render it as a softly rounded
  // rectangle filled with a "frosted glass" tone (slightly cooler than
  // the BG so it reads as a separate material). Then a thin specular
  // highlight on the top edge to cue the glassy surface.
  ctx.save();
  if (rotateDeg !== 0) {
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((rotateDeg * Math.PI) / 180);
    ctx.translate(-outW / 2, -outH / 2);
  }

  const radius = Math.round(panelW * 0.025);
  drawRoundedRect(ctx, panelX, panelY, panelW, panelH, radius);
  // Frosted-glass body — dampened version of background with cool cast.
  const panelGrad = ctx.createLinearGradient(panelX, panelY, panelX, panelY + panelH);
  panelGrad.addColorStop(0, "rgba(248, 250, 252, 0.55)");
  panelGrad.addColorStop(1, "rgba(228, 232, 238, 0.55)");
  ctx.fillStyle = panelGrad;
  ctx.fill();

  // Thin top-edge highlight — light catches the bevel.
  drawRoundedRect(ctx, panelX, panelY, panelW, 2, radius);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fill();
  // Subtle right/bottom edge darkening for depth.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, panelX, panelY, panelW, panelH, radius);
  ctx.stroke();

  // 4. Optional white-ink underlay — a near-opaque off-white inset
  // matching the design's footprint. UV printers lay this down BEHIND
  // the colour layer so the design reads opaque on clear acrylic.
  // Without it (showInk=false), light parts of the design will appear
  // washed out / almost invisible against the translucent panel — that's
  // the realistic look the user is checking for.
  const designX = panelX + padding;
  const designY = panelY + (panelH - (panelW - padding * 2) * designAspect) / 2;
  const designW = panelW - padding * 2;
  const designH = designW * designAspect;

  if (showInk) {
    ctx.fillStyle = "rgba(252, 252, 250, 0.92)";
    // Inset slightly so the underlay reads as a separate ink pass.
    ctx.fillRect(designX - 2, designY - 2, designW + 4, designH + 4);
  }

  // 5. The actual design.
  ctx.drawImage(design, designX, designY, designW, designH);

  ctx.restore();

  return out;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
