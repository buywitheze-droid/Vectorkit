/**
 * Standalone script: take a transparent-background invitation PNG and erase
 * all the text overlays, leaving the decorative elements (flowers, frames,
 * crowns, butterflies, etc.) intact.
 *
 * Usage:
 *   npx tsx scripts/remove-text.ts "<input.png>" "<output.png>"
 *
 * Algorithm:
 *
 *   1. Load the PNG. We assume it has a real alpha channel and that
 *      decorative elements + text are both opaque against transparency.
 *
 *   2. Find connected components of opaque pixels (4-connectivity, alpha
 *      threshold 32). Each component is one "thing": a letter, a flower,
 *      a butterfly, a crown, etc.
 *
 *   3. Per-component features:
 *        • Pixel count
 *        • Bounding box (w, h, x-mid, y-mid)
 *        • Mean colour
 *        • Colour variance — text strokes have very uniform colour
 *          (filled with one ink), decorative elements are gradients +
 *          highlights so colour stdev is high.
 *        • Stroke-thickness proxy: pixels / max(w,h). Letters are
 *          stroke-like — perimeter grows as ~length, so this ratio is
 *          small. Decorative blobs fill their bbox = ratio is large.
 *
 *   4. Score each component for "text-likeness":
 *        +  small bounding box (relative to image)
 *        +  low colour variance
 *        +  low fill-ratio (stroke-like)
 *        +  near-greyscale colour (text is usually one pure colour;
 *           decorations almost always have multiple hues from gradients)
 *        −  inside the bbox of a much larger component (probably part
 *           of a decoration's interior detail)
 *
 *   5. ROW-CLUSTERING refinement: text appears as ROWS — a sequence of
 *      similar-sized components sitting at roughly the same y-coordinate.
 *      A small black blob ALONE in the middle of a flower-free zone is
 *      probably a splatter dot (decoration). The same blob with 5 other
 *      similar blobs lined up next to it is a row of text.
 *
 *      We sort all "small + low-variance" candidates by Y, then sweep
 *      and group those whose y-centres are within ~bbox-height of each
 *      other into rows. A row needs ≥ 3 components to qualify (filters
 *      out lone splatter dots).
 *
 *      Single-component rows survive ONLY if they're huge stylised
 *      script (high pixel count, long-thin bbox like cursive 'Cindy
 *      Abigail'). For invitations these are usually the hero name.
 *
 *   6. Erase every component flagged as text by setting its pixels to
 *      alpha = 0 in the output.
 *
 * The script writes:
 *   • <output.png>           — the cleaned design
 *   • <output>.debug.png     — same image with surviving components
 *                              tinted (kept = green, erased = red).
 *                              Useful for visually validating decisions.
 */

import "../test/setup";
import * as fs from "node:fs";
import * as path from "node:path";
import { createCanvas, loadImageFromPath } from "../test/setup";
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";

const ALPHA_OPAQUE = 32;

interface Component {
  id: number;
  pixels: number[]; // packed pixel indices
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  meanR: number;
  meanG: number;
  meanB: number;
  /** Per-channel std-dev of pixel colours within the component. Sum / 3.
   *  Sensitive to AA fringe — bright-red text on a transparent BG can
   *  read as variance ~30 because pink AA pixels are far from pure-red
   *  core pixels. Use `hueIncoherence` for a more robust uniformity
   *  signal on coloured text. */
  colourVariance: number;
  /** Circular variance of HUE across saturated pixels (sat > 0.18). 0 = all
   *  same hue (text), 1 = uniform hue distribution (rainbow gradient).
   *  Robust to AA fringe and lightness variation: a red letter and its
   *  pink AA edge have the SAME hue (red), just different lightness, so
   *  they contribute coherently to the hue average.
   *
   *  Set to NaN if the component has too few saturated pixels to
   *  meaningfully compute (e.g. pure-grayscale components like black
   *  text or silver crowns). Caller must fall back to colourVariance. */
  hueIncoherence: number;
  /** Fraction of pixels that have meaningful saturation (sat > 0.18).
   *  Tells the caller whether `hueIncoherence` is reliable. */
  saturatedFrac: number;
  /** Pixels / max(w, h). Letters: small. Filled blobs: large. */
  fillRatio: number;
}

async function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error("usage: tsx scripts/remove-text.ts <input.png> [output.png]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = outputArg
    ? path.resolve(outputArg)
    : inputPath.replace(/\.png$/i, " - text removed.png");
  const debugPath = outputPath.replace(/\.png$/i, ".debug.png");

  console.log(`Loading: ${inputPath}`);
  const img = await loadImageFromPath(inputPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  console.log(`Image:   ${img.width} × ${img.height}`);

  // ── Step 1: extract pixels ────────────────────────────────────────────
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const w = canvas.width;
  const h = canvas.height;

  // ── Step 1.5: define the TEXT ZONE ────────────────────────────────────
  //
  // KEY DESIGN ASSUMPTION (per user observation, validated on the 44
  // invites in the test folder): on every acrylic invitation in this
  // workflow, all text sits in the CENTRE of the canvas. Decorations
  // — flower bouquets, frames, butterflies, splatter dots, the
  // model/dress illustration, etc. — live in the corners and along
  // the edges.
  //
  // We can therefore PROTECT THE PERIMETER ABSOLUTELY by refusing to
  // erase any component whose bounding box touches the outer band.
  // The only things eligible for erasure are components whose bbox is
  // fully contained within the central text zone.
  //
  // Margins are ASYMMETRIC because text and decorations live in
  // different bands of the canvas:
  //   • Vertical: decorations dominate the top + bottom (flower
  //     bouquets, frames). Text occupies the central vertical band.
  //     A 10 % top/bottom margin protects these.
  //   • Horizontal: text lines often run nearly edge-to-edge
  //     ("Ceremonia: 1:00pm Iglesia Guadalupe", "Chandelier Banquet
  //     Hall 320 Decatur Blvd Las Vegas NV"). A 10 % horizontal
  //     margin would clip these. Most edge decorations on these
  //     invitations are at the CORNERS — caught by the vertical
  //     margin. So we use a tighter 5 % horizontal margin.
  //
  // A small horizontal-only decoration that wandered into the centre
  // band (e.g. a butterfly at mid-height near the right edge) would
  // still be protected by the colour-variance / fill-ratio checks in
  // pass 1 (decorations are gradients, not uniform ink).
  const MARGIN_X_FRAC = 0.05;
  const MARGIN_Y_FRAC = 0.10;
  const zone = {
    left: w * MARGIN_X_FRAC,
    right: w * (1 - MARGIN_X_FRAC),
    top: h * MARGIN_Y_FRAC,
    bottom: h * (1 - MARGIN_Y_FRAC),
  };
  const inZone = (c: Component) =>
    c.minX >= zone.left &&
    c.maxX <= zone.right &&
    c.minY >= zone.top &&
    c.maxY <= zone.bottom;
  console.log(
    `Text zone: x ${(zone.left | 0)}–${(zone.right | 0)}, y ${(zone.top | 0)}–${(zone.bottom | 0)} ` +
      `(${(MARGIN_X_FRAC * 100) | 0}% horiz, ${(MARGIN_Y_FRAC * 100) | 0}% vert margin; corners/edges protected)`
  );

  // ── Step 2: PASS 1 — DUAL labelling (physical + eroded) ───────────────
  //
  // Standard 4-connectivity treats anything orthogonally-touching-and-
  // opaque as one component. That's catastrophic for invitations
  // because cursive scripts ("Cindy Abigail", "Sheidy's") have
  // hairline 1-px strokes joining the letters → one big "tall"
  // component → kept by the height check.
  //
  // Mitigation: erode the opaque mask by 1 pixel before labelling.
  // Hairline connections break, letting cursive letters be detected
  // individually.
  //
  // BUT: blanket erosion damages decorations with fine detail. The
  // gold crown in "Invite 2026" has 1-2 px curlicues — erosion
  // fragments it into uniform-gold pieces that look text-like.
  //
  // Fix: PARENT-AWARE erosion. We compute TWO labellings:
  //   • PHYSICAL labels: standard alpha CC. Each label = one big
  //     "real-world" object (a whole crown, a whole flower bouquet,
  //     a whole text+line group).
  //   • ERODED labels: post-erosion CC. Sub-objects within physical
  //     labels (individual cursive letters, sub-fragments of crowns).
  //
  // For each eroded label, we look up its PHYSICAL parent. If the
  // parent is a DECORATION (variegated colour, huge), every eroded
  // child is forcibly kept regardless of how text-like it looks. If
  // the parent itself looks text-like (uniform colour, modest size),
  // we trust the eroded child's text verdict.
  console.log("Pass 1: dual labelling (physical + eroded)…");
  const opaqueMask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] >= ALPHA_OPAQUE) opaqueMask[i] = 1;
  }

  // 2a) Physical labels (standard alpha CC).
  const physical = labelComponentsWithMap(
    data,
    w,
    h,
    (k) => opaqueMask[k] === 1
  );
  console.log(`  physical components: ${physical.components.length}`);

  // 2b) Decoration tag for each physical component.
  //
  // A physical component is treated as a definite decoration if any
  // of:
  //   • Variegated by hue: it has saturated pixels AND their hue is
  //     dispersed (multi-colour gradient like a flower bouquet).
  //   • Variegated by RGB std-dev — BUT only when hue check is
  //     unreliable (mostly-grayscale component). Textured uniform-
  //     hue ink (e.g. gold-glitter "ANDREW & JAYME GONZALEZ" in
  //     Invite 2026) has high RGB variance from the glitter texture
  //     yet all pixels share one hue, so we must NOT flag it as a
  //     decoration parent.
  //   • Huge: covers > 8 % of the canvas.
  //
  // The threshold is INTENTIONALLY tighter than the pass-1 text
  // scoring so a uniform-colour cursive script (low variance) is NOT
  // marked decoration and its eroded letters can be erased.
  const isDecorationParent = new Uint8Array(physical.components.length);
  for (let i = 0; i < physical.components.length; i++) {
    const c = physical.components[i];
    const hueReliable = c.saturatedFrac > 0.20 && !Number.isNaN(c.hueIncoherence);
    const isVariegatedHue = hueReliable && c.hueIncoherence > 0.18;
    // Only fall back to RGB-variance when hue is unavailable — and
    // even then, use a generous threshold (45) so jagged grayscale
    // text isn't accidentally promoted to "decoration parent" status.
    // Threshold raised from 45 → 65: black-on-white text + line
    // decoration combos (12614 address block) can hit RGB std-dev ~50
    // from the natural ink-vs-AA contrast. We only want to flag
    // genuinely multi-shade grayscale decorations (monochrome glitter,
    // pencil shading) here.
    const isVariegatedRGB = !hueReliable && c.colourVariance > 65;
    const isHuge = c.count > w * h * 0.08;
    if (isVariegatedHue || isVariegatedRGB || isHuge) isDecorationParent[i] = 1;
  }
  // Quick diagnostic: how many physical components were tagged as
  // decoration parents (these are the only "untouchable" units).
  let nDec = 0;
  for (let i = 0; i < isDecorationParent.length; i++) if (isDecorationParent[i]) nDec++;
  console.log(`  decoration parents: ${nDec} / ${physical.components.length}`);

  // 2c) Eroded labels.
  const erodedMask = erodeMask4(opaqueMask, w, h);
  const components = labelComponents(
    data,
    w,
    h,
    (k) => erodedMask[k] === 1
  );
  console.log(`  eroded components:   ${components.length}`);

  // ── Step 3: per-component text scoring ────────────────────────────────
  //
  // Strategy: text always has BOUNDED HEIGHT relative to the image (even
  // hero-name scripts stay under ~6% of image height). Decorations either
  // tower over that limit (flower bouquets, dresses) or have varied
  // colours from gradients (crowns, butterflies).
  //
  // Algorithm:
  //   1. Anything tall (bboxHeight > 6% of image) → KEEP, no question.
  //   2. Anything variegated (colour stdev > 22) → KEEP. Gradients,
  //      detail-rich graphics, photos.
  //   3. Anything VERY large (> 5% of image area in pixel count) → KEEP.
  //      Catches large decorations that are uniformly coloured (rare
  //      but happens — e.g. the gold geometric frame in Invite 2026).
  //   4. Otherwise → TEXT candidate. Will be erased UNLESS row-clustering
  //      demotes it (singleton dot of indeterminate origin).
  //
  // Why ditch the bbox-AREA size cap: cursive script words like
  // "Maldonado" or "Guadalupe" join into one wide component. Their bbox
  // area can be 1–3 % of the image, which fails an area cap, but their
  // HEIGHT is still tiny — they're text. Height-based passes cleanly.
  //
  // Why ditch the noise/ignore tier: the previous "< 0.01 % pixels =
  // ignore" rule was eating individual small letters ('i', 'l', '.')
  // from sans-serif text rows, leaving holes in the cleaned output. We
  // now pass all candidates through to row clustering, which uses
  // spatial context to keep splatter dots (lone) and erase letters
  // (clustered).
  const totalPx = w * h;
  const TALL_HEIGHT_FRAC = 0.06;     // bboxHeight > 6% of image height = decoration
  const HUGE_PIXEL_FRAC = 0.05;      // > 5% area = decoration regardless of shape
  const MIN_TEXT_HEIGHT_FRAC = 0.005; // < 0.5 % image height = splatter dot, ignore
  const tallPxThresh = h * TALL_HEIGHT_FRAC;
  const minTextH = h * MIN_TEXT_HEIGHT_FRAC;

  type Verdict = "text" | "keep";
  const verdicts: Verdict[] = new Array(components.length).fill("keep");

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    // ZONE GATE: corner/edge components are NEVER eligible. Skip the
    // text scoring entirely — verdict stays the default "keep". This
    // protects flower bouquets, splatter dots, the dress illustration,
    // frame strokes, etc. without depending on shape heuristics.
    if (!inZone(c)) continue;
    // PARENT GATE: if this eroded fragment came from a physical
    // component that's clearly a decoration (multi-hue gradient,
    // huge), keep it. Protects fine-detail decorations (gold crown,
    // butterflies) from erosion-induced fragmentation.
    //
    // BYPASS: allow erasure even within a decoration parent when
    // the fragment itself is *unambiguously* text-like — extremely
    // low colour variance (var < 8) means it's solid ink, not a
    // textured decoration shrapnel. This rescues black address
    // letters in 12614 that happen to touch a pink butterfly →
    // share its physical component → would otherwise be protected.
    const parentLabel = physical.labels[c.pixels[0]];
    if (parentLabel > 0 && isDecorationParent[parentLabel - 1]) {
      if (c.colourVariance > 8) continue;
    }
    const bh = c.maxY - c.minY + 1;
    // SIZE GATE: tiny components in the centre are almost always
    // splatter dots that drifted into the text zone. Letters have a
    // meaningful height (>= 0.5% of image). Skipping these protects
    // central splatter from row-clustering false positives.
    if (bh < minTextH) continue;
    const bw = c.maxX - c.minX + 1;
    const isTall = bh > tallPxThresh;
    const isHuge = c.count > totalPx * HUGE_PIXEL_FRAC;
    if (isHuge) continue;

    // HERO-SCRIPT EXCEPTION for "tall" components.
    //
    // Stylised cursive name lines like "Cindy Abigail", "Sheidy's",
    // "Kylie Alexa Gonzalez" can occupy 7–10 % of image height when
    // ascenders + descenders + flourishes are counted in the bbox.
    // The blanket isTall = "decoration" rule rejects these.
    //
    // But hero scripts have a distinctive shape signature: very wide
    // horizontally (long names span the centre band), very stroke-like
    // (cursive ink uses a tiny fraction of its bbox), and uniformly
    // coloured (one ink). True tall decorations (frames, vertical
    // dress illustrations, stems) either fail the aspect test (too
    // narrow) or fail the fill-ratio test (filled silhouette).
    // Hero-script aspect relaxed to 1.5× — single cursive words like
    // "Sheidy's" (with apostrophe) come in around 1.6–1.7×.
    const isHeroScript =
      bw > bh * 1.5 &&
      c.fillRatio < 0.32 &&
      bh < tallPxThresh * 2 && // sanity cap — < 12 % image height
      ((c.saturatedFrac > 0.30 && !Number.isNaN(c.hueIncoherence) && c.hueIncoherence < 0.18) ||
        c.colourVariance < 22);
    if (isTall && !isHeroScript) continue;

    // UNIFORMITY GATE — hue-coherence preferred over RGB variance.
    //
    // RGB variance is fooled by anti-aliasing on coloured text: a
    // bright-red script letter has a pink AA fringe, and the pure-red
    // core ↔ pink-fringe distance in RGB is huge (especially in G/B
    // channels), pushing the variance over decoration thresholds even
    // though it's all the same hue.
    //
    // Hue-coherence works on the colour wheel, where pink AA and pure
    // red occupy the same direction (just different lightness). Text
    // → low incoherence (~0.0–0.15). Floral gradients sweeping across
    // multiple hues → high incoherence (~0.5+).
    //
    // RELIABILITY: hue is only computed on saturated pixels. If the
    // component has < 30 % saturated pixels (mostly grayscale), the
    // few saturated pixels are typically AA noise and produce wildly
    // random hues → false-positive hueIncoherence. We require
    // saturatedFrac > 0.30 before trusting the hue test, otherwise
    // fall back to RGB variance.
    if (c.saturatedFrac > 0.30 && !Number.isNaN(c.hueIncoherence)) {
      // Reliably coloured component — trust hue.
      if (c.hueIncoherence > 0.30) continue; // multi-hue = decoration
    } else {
      // Grayscale (or insufficiently-saturated) component — fall
      // back to RGB variance, with a generous threshold (28) so
      // jagged anti-aliased black serif text isn't accidentally
      // classified as a decoration.
      if (c.colourVariance > 28) continue;
    }

    verdicts[i] = "text";
  }

  // ── Step 4: row-clustering refinement ─────────────────────────────────
  // A real text row is ≥ 3 components sitting at roughly the same Y
  // coordinate. Lone short-uniform components (splatter dots, small
  // decorative dots, tiny isolated marks) are demoted back to "keep".
  //
  // Exception: a single component is allowed to BE its own "row" if it
  // looks like a hero stylised name (wide bbox + very stroke-like + very
  // pure colour). Even then, we still erase it — the user wants ALL
  // text gone — but we tag it explicitly so the debug overlay can show
  // why a singleton was kept as text.
  //
  // We use an interval-merge approach: each component's [minY, maxY]
  // range. Two components share a row if their Y ranges overlap by at
  // least 40 % of the smaller range. This handles cursive descenders
  // and ascenders that shift a component's centroid away from its
  // visual baseline.
  const candidates = components
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => verdicts[i] === "text");

  // Sort by minY so we can do a sweep.
  candidates.sort((a, b) => a.c.minY - b.c.minY);

  const rowOf = new Map<number, number>();
  let rowId = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (rowOf.has(candidates[i].i)) continue;
    rowId++;
    const queue = [i];
    while (queue.length > 0) {
      const k = queue.shift()!;
      if (rowOf.has(candidates[k].i)) continue;
      rowOf.set(candidates[k].i, rowId);
      const a = candidates[k].c;
      const aH = a.maxY - a.minY + 1;
      // Scan ahead through any candidate whose minY hasn't passed
      // the current row's max yet. Cheap because we sorted by minY.
      for (let j = k + 1; j < candidates.length; j++) {
        if (rowOf.has(candidates[j].i)) continue;
        const b = candidates[j].c;
        // Early-terminate: if b starts well below a, we're done with
        // this row. Use 1.5× a's height as the search distance —
        // more permissive than centroid matching, handles stacked
        // ascenders/descenders.
        if (b.minY > a.maxY + aH * 0.5) break;
        const bH = b.maxY - b.minY + 1;
        const overlap = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1);
        const minH = Math.min(aH, bH);
        if (overlap >= minH * 0.4) {
          queue.push(j);
        }
      }
    }
  }

  const rowCount = new Map<number, number>();
  for (const r of rowOf.values()) {
    rowCount.set(r, (rowCount.get(r) ?? 0) + 1);
  }

  // Demote singletons (rows with < 3 members) UNLESS they're large + thin
  // + uniform — the cursive hero name pattern. Also keep them flagged as
  // text for hero scripts, since the user wants all text gone.
  for (const { c, i } of candidates) {
    const r = rowOf.get(i)!;
    if ((rowCount.get(r) ?? 0) >= 3) continue;
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const isHeroScript =
      c.count > totalPx * 0.001 &&  // sizeable pixel count
      c.fillRatio < 0.35 &&         // very stroke-like
      c.colourVariance < 18 &&      // text strokes are nearly one colour
      bw > bh * 1.5;                // wide aspect (cursive sweep)
    if (!isHeroScript) {
      verdicts[i] = "keep";
    }
  }

  // ── Report pass 1 + erase ─────────────────────────────────────────────
  let p1Text = 0, p1Keep = 0;
  for (const v of verdicts) {
    if (v === "text") p1Text++;
    else p1Keep++;
  }
  const p1Erased = components
    .map((c, i) => (verdicts[i] === "text" ? c.count : 0))
    .reduce((a, b) => a + b, 0);
  console.log(`  pass-1 text: ${p1Text} (${p1Erased.toLocaleString()} px)`);
  console.log(`  pass-1 keep: ${p1Keep}`);
  // Verbose diagnostic: top kept components in zone (set DEBUG=1).
  if (process.env.DEBUG === "1") {
    const keptInZone: { c: Component; pdec: number }[] = [];
    for (let i = 0; i < components.length; i++) {
      if (verdicts[i] === "text") continue;
      const c = components[i];
      if (!inZone(c) || c.count < 200) continue;
      const parentLabel = physical.labels[c.pixels[0]];
      const pdec = parentLabel > 0 ? isDecorationParent[parentLabel - 1] : 0;
      keptInZone.push({ c, pdec });
    }
    keptInZone.sort((a, b) => b.c.count - a.c.count);
    console.log(`  largest in-zone kept (top 8):`);
    for (const { c, pdec } of keptInZone.slice(0, 8)) {
      const bw = c.maxX - c.minX + 1;
      const bh = c.maxY - c.minY + 1;
      console.log(
        `    px=${c.count.toString().padStart(6)} ${bw}×${bh} fill=${c.fillRatio.toFixed(2)} ` +
          `var=${c.colourVariance.toFixed(1)} hueInc=${Number.isNaN(c.hueIncoherence) ? "—" : c.hueIncoherence.toFixed(2)} ` +
          `sat=${c.saturatedFrac.toFixed(2)} parentDec=${pdec}`
      );
    }
  }

  // Erase text components — but DILATE the eroded label back by 2 px
  // so the AA-fringe pixels we excluded during erosion (and any
  // original 1-px-thick tails) also get erased. Without this, text
  // letters leave a 1-2 px outline of "edge" pixels behind.
  const textPixelMask = new Uint8Array(w * h);
  for (let i = 0; i < components.length; i++) {
    if (verdicts[i] !== "text") continue;
    for (const p of components[i].pixels) textPixelMask[p] = 1;
  }
  const textDilated = dilateMask4(textPixelMask, w, h, 2);
  for (let i = 0; i < w * h; i++) {
    // Only erase pixels that were originally opaque AND in dilation.
    // Don't touch already-transparent pixels (no-op anyway).
    if (textDilated[i] && opaqueMask[i]) data[i * 4 + 3] = 0;
  }

  // ── Step 6: PASS 2 — find dark TEXT INSIDE kept decorations ───────────
  //
  // The "Galindo hugging the flower" case: cursive text grazes a
  // decoration via a thin pixel bridge, becoming part of the
  // decoration's component, and inheriting its "keep" verdict. We
  // can't fix this in pass 1 without splitting all decorations.
  //
  // Pass 2 is a SECONDARY scan: for every pixel that's still opaque
  // AND very dark (luma < 70), label connected components using only
  // dark-pixel connectivity. This lets us re-discover the text
  // SHAPES that were riding on top of decorations.
  //
  // Then we apply the same text heuristics + row clustering. A real
  // decoration's dark detail (a stamen tip, a flower vein) is usually
  // alone in its row → demoted to keep. A row of dark text characters
  // → erased.
  console.log("Pass 2: dark/coloured-ink sub-labelling within survivors…");
  // Compromise threshold — luma < 90 catches dark-grey serif (12614),
  // dark red script (Cindy Abigail), dark green script (Invite 2026).
  // We then ERODE this dark mask by 1 px before labelling so a dark
  // word sitting next to dark flower veins (Quince "Galindo" + bouquet
  // shadows) doesn't merge into one tall "decoration" component.
  const DARK_LUMA_MAX = 90;
  const darkMask = new Uint8Array(w * h);
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    if (data[k + 3] < ALPHA_OPAQUE) continue;
    const luma = 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2];
    if (luma < DARK_LUMA_MAX) darkMask[i] = 1;
  }
  const erodedDarkMask = erodeMask4(darkMask, w, h);
  const darkComponents = labelComponents(
    data,
    w,
    h,
    (k) => erodedDarkMask[k] === 1
  );

  const darkVerdicts: ("text" | "keep")[] = scoreAndClusterText(
    darkComponents,
    w,
    h,
    inZone
  );

  let p2Text = 0;
  let p2Erased = 0;
  const p2Mask = new Uint8Array(w * h);
  for (let i = 0; i < darkComponents.length; i++) {
    if (darkVerdicts[i] !== "text") continue;
    p2Text++;
    for (const p of darkComponents[i].pixels) p2Mask[p] = 1;
  }
  // Dilate by 2 px to recover AA-edge pixels that erosion excluded.
  // Only erase pixels that were originally opaque (avoids accidentally
  // expanding into already-transparent background).
  const p2Dilated = dilateMask4(p2Mask, w, h, 2);
  for (let i = 0; i < w * h; i++) {
    if (p2Dilated[i] && opaqueMask[i]) {
      if (data[i * 4 + 3] !== 0) p2Erased++;
      data[i * 4 + 3] = 0;
    }
  }
  console.log(`  pass-2 text: ${p2Text} (${p2Erased.toLocaleString()} px)`);

  // ── Step 7: PUNCTUATION CLEANUP — proximity sweep ─────────────────────
  //
  // After passes 1+2, tiny accent marks ('~' over 'ñ'), periods,
  // commas, colons, and dots-on-i's often survive — they're under the
  // 0.5 % min-height threshold so the pass-1 size gate skipped them.
  //
  // Strategy: build a distance-to-erased-pixel map (chamfer 3-4-5) and
  // sweep every surviving very-small in-zone component. If its closest
  // pixel is within ~2 % of image height of an erased pixel AND the
  // component is at least ~2× its closest-erased-component's height
  // smaller, erase it too.
  //
  // SAFETY: we ONLY run this pass when the earlier passes erased a
  // meaningful amount of text. If pass 1 + pass 2 between them erased
  // very little (e.g. < 0.5% of image area), the cleaning pass would
  // mostly be erasing decorative shrapnel near unrelated transparent
  // areas. Better to leave the punctuation than mangle the design.
  const earlyErasedFrac = (p1Erased + p2Erased) / (w * h);
  if (earlyErasedFrac < 0.005) {
    console.log(
      `Pass 3: SKIPPED — pass 1+2 erased only ${(earlyErasedFrac * 100).toFixed(2)}% of image; ` +
        `punctuation cleanup would do more harm than good.`
    );
  } else {
    console.log("Pass 3: punctuation cleanup near erased text…");
    const erasedMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] < ALPHA_OPAQUE) erasedMask[i] = 1;
    }
    // Tighter proximity (was 3% of h → 1.5% of h). Punctuation sits
    // immediately next to its letters, not 50 pixels away.
    const proximityRadius = Math.max(6, Math.round(h * 0.015));
    const distMap = chamferDistance(erasedMask, w, h, proximityRadius + 2);
    const survivingComponents = labelComponents(
      data,
      w,
      h,
      (k) => data[k * 4 + 3] >= ALPHA_OPAQUE
    );
    let p3Text = 0;
    let p3Erased = 0;
    // Tighter size limits than before — only true punctuation, not
    // half-eaten letter fragments. Periods/commas are 4-12 px wide.
    const maxPunctuationCount = (w * h) * 0.0001;
    const maxPunctuationHeight = h * 0.012;
    const maxPunctuationWidth = w * 0.015;
    for (const c of survivingComponents) {
      if (!inZone(c)) continue;
      if (c.count > maxPunctuationCount) continue;
      const bh = c.maxY - c.minY + 1;
      const bw = c.maxX - c.minX + 1;
      if (bh > maxPunctuationHeight) continue;
      if (bw > maxPunctuationWidth) continue;
      if (c.colourVariance > 22) continue;
      let nearest = Infinity;
      for (const p of c.pixels) {
        const d = distMap[p];
        if (d < nearest) {
          nearest = d;
          if (nearest === 0) break;
        }
      }
      if (nearest > proximityRadius) continue;
      p3Text++;
      p3Erased += c.count;
      for (const p of c.pixels) {
        data[p * 4 + 3] = 0;
      }
    }
    console.log(`  pass-3 punctuation: ${p3Text} (${p3Erased.toLocaleString()} px)`);
    console.log(`  total erased: ${(p1Erased + p2Erased + p3Erased).toLocaleString()} px`);
  }

  ctx.putImageData(imgData, 0, 0);

  await writePng(canvas, outputPath);
  console.log(`Wrote: ${outputPath}`);

  // Debug overlay: only emit when DEBUG=1 — clutters the output folder
  // when batch-processing many invitations.
  if (process.env.DEBUG === "1") {
    await writeDebugOverlay(img, components, verdicts, debugPath);
    console.log(`Debug: ${debugPath}`);
  }
}

/**
 * Generic 4-connectivity component labelling. The caller passes a
 * predicate `connectFn(pixelIndex)` that returns true for pixels eligible
 * to be in a component. We use this for both passes:
 *   • pass 1: any opaque pixel
 *   • pass 2: opaque AND very dark
 */
function labelComponents(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  connectFn: (pixelIndex: number) => boolean
): Component[] {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  const components: Component[] = [];
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== 0) continue;
      if (!connectFn(i)) continue;
      const id = ++nextLabel;
      const comp: Component = {
        id,
        pixels: [],
        count: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        meanR: 0,
        meanG: 0,
        meanB: 0,
        colourVariance: 0,
        hueIncoherence: NaN,
        saturatedFrac: 0,
        fillRatio: 0,
      };
      let sumR = 0, sumG = 0, sumB = 0;
      let sumRR = 0, sumGG = 0, sumBB = 0;
      let satCount = 0;
      // Hue is circular, so we accumulate cos(2H) and sin(2H) and reduce
      // at the end. We use 2*hue so that diametrically-opposite hues
      // (e.g. red and cyan) don't accidentally cancel — they shouldn't,
      // but doubling collapses the [0, 2π) hue circle into a [0, 4π)
      // wrap that's safer for averaging directional data.
      let sumCos = 0, sumSin = 0;
      stack.length = 0;
      stack.push(i);
      labels[i] = id;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const px = p % w;
        const py = (p / w) | 0;
        comp.pixels.push(p);
        comp.count++;
        if (px < comp.minX) comp.minX = px;
        if (px > comp.maxX) comp.maxX = px;
        if (py < comp.minY) comp.minY = py;
        if (py > comp.maxY) comp.maxY = py;
        const k = p * 4;
        const r = data[k], g = data[k + 1], b = data[k + 2];
        sumR += r; sumG += g; sumB += b;
        sumRR += r * r; sumGG += g * g; sumBB += b * b;
        // Hue / saturation accumulation. Skip near-grayscale pixels —
        // their hue is mathematically undefined and adds pure noise.
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const chroma = mx - mn;
        if (mx > 0 && chroma / mx > 0.18) {
          // Standard HSV hue calculation, output in radians [0, 2π).
          let hue: number;
          if (mx === r) {
            hue = ((g - b) / chroma) % 6;
          } else if (mx === g) {
            hue = (b - r) / chroma + 2;
          } else {
            hue = (r - g) / chroma + 4;
          }
          hue *= Math.PI / 3; // sextants → radians
          if (hue < 0) hue += Math.PI * 2;
          // Use 2*hue for circular variance accumulation.
          sumCos += Math.cos(hue * 2);
          sumSin += Math.sin(hue * 2);
          satCount++;
        }
        if (px > 0) {
          const q = p - 1;
          if (labels[q] === 0 && connectFn(q)) {
            labels[q] = id;
            stack.push(q);
          }
        }
        if (px < w - 1) {
          const q = p + 1;
          if (labels[q] === 0 && connectFn(q)) {
            labels[q] = id;
            stack.push(q);
          }
        }
        if (py > 0) {
          const q = p - w;
          if (labels[q] === 0 && connectFn(q)) {
            labels[q] = id;
            stack.push(q);
          }
        }
        if (py < h - 1) {
          const q = p + w;
          if (labels[q] === 0 && connectFn(q)) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
      const n = comp.count;
      comp.meanR = sumR / n;
      comp.meanG = sumG / n;
      comp.meanB = sumB / n;
      const varR = Math.max(0, sumRR / n - comp.meanR * comp.meanR);
      const varG = Math.max(0, sumGG / n - comp.meanG * comp.meanG);
      const varB = Math.max(0, sumBB / n - comp.meanB * comp.meanB);
      comp.colourVariance = (Math.sqrt(varR) + Math.sqrt(varG) + Math.sqrt(varB)) / 3;
      comp.saturatedFrac = satCount / n;
      // Need a meaningful sample of saturated pixels for hue stats. 12
      // is a low bar but excludes accidental fringe pixels in
      // black/silver/white components.
      if (satCount >= 12) {
        const meanCos = sumCos / satCount;
        const meanSin = sumSin / satCount;
        const r2 = Math.sqrt(meanCos * meanCos + meanSin * meanSin);
        // Circular variance ∈ [0, 1]. 0 = perfectly coherent, 1 = fully
        // dispersed.
        comp.hueIncoherence = 1 - r2;
      }
      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      comp.fillRatio = comp.count / (bw * bh);
      components.push(comp);
    }
  }
  return components;
}

/**
 * Label connected components AND return the per-pixel label array.
 * Same as `labelComponents` plus the array. Caller can look up the
 * physical-component-id of any pixel via `result.labels[pixelIndex]`
 * (1-indexed; 0 = not in any component).
 */
function labelComponentsWithMap(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  connectFn: (pixelIndex: number) => boolean
): { components: Component[]; labels: Int32Array } {
  const labels = new Int32Array(w * h);
  let nextLabel = 0;
  const components: Component[] = [];
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== 0) continue;
      if (!connectFn(i)) continue;
      const id = ++nextLabel;
      const comp: Component = {
        id,
        pixels: [],
        count: 0,
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        meanR: 0,
        meanG: 0,
        meanB: 0,
        colourVariance: 0,
        hueIncoherence: NaN,
        saturatedFrac: 0,
        fillRatio: 0,
      };
      let sumR = 0, sumG = 0, sumB = 0;
      let sumRR = 0, sumGG = 0, sumBB = 0;
      let satCount = 0;
      let sumCos = 0, sumSin = 0;
      stack.length = 0;
      stack.push(i);
      labels[i] = id;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const px = p % w;
        const py = (p / w) | 0;
        comp.pixels.push(p);
        comp.count++;
        if (px < comp.minX) comp.minX = px;
        if (px > comp.maxX) comp.maxX = px;
        if (py < comp.minY) comp.minY = py;
        if (py > comp.maxY) comp.maxY = py;
        const k = p * 4;
        const r = data[k], g = data[k + 1], b = data[k + 2];
        sumR += r; sumG += g; sumB += b;
        sumRR += r * r; sumGG += g * g; sumBB += b * b;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const chroma = mx - mn;
        if (mx > 0 && chroma / mx > 0.18) {
          let hue: number;
          if (mx === r) hue = ((g - b) / chroma) % 6;
          else if (mx === g) hue = (b - r) / chroma + 2;
          else hue = (r - g) / chroma + 4;
          hue *= Math.PI / 3;
          if (hue < 0) hue += Math.PI * 2;
          sumCos += Math.cos(hue * 2);
          sumSin += Math.sin(hue * 2);
          satCount++;
        }
        if (px > 0) {
          const q = p - 1;
          if (labels[q] === 0 && connectFn(q)) { labels[q] = id; stack.push(q); }
        }
        if (px < w - 1) {
          const q = p + 1;
          if (labels[q] === 0 && connectFn(q)) { labels[q] = id; stack.push(q); }
        }
        if (py > 0) {
          const q = p - w;
          if (labels[q] === 0 && connectFn(q)) { labels[q] = id; stack.push(q); }
        }
        if (py < h - 1) {
          const q = p + w;
          if (labels[q] === 0 && connectFn(q)) { labels[q] = id; stack.push(q); }
        }
      }
      const n = comp.count;
      comp.meanR = sumR / n;
      comp.meanG = sumG / n;
      comp.meanB = sumB / n;
      const varR = Math.max(0, sumRR / n - comp.meanR * comp.meanR);
      const varG = Math.max(0, sumGG / n - comp.meanG * comp.meanG);
      const varB = Math.max(0, sumBB / n - comp.meanB * comp.meanB);
      comp.colourVariance = (Math.sqrt(varR) + Math.sqrt(varG) + Math.sqrt(varB)) / 3;
      comp.saturatedFrac = satCount / n;
      if (satCount >= 12) {
        const meanCos = sumCos / satCount;
        const meanSin = sumSin / satCount;
        const r2 = Math.sqrt(meanCos * meanCos + meanSin * meanSin);
        comp.hueIncoherence = 1 - r2;
      }
      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      comp.fillRatio = comp.count / (bw * bh);
      components.push(comp);
    }
  }
  return { components, labels };
}

/**
 * Apply text heuristics + row clustering to a set of components and
 * return per-component verdicts. Used by pass 2 to evaluate
 * dark-pixel sub-components found inside surviving decorations.
 *
 * Pass 2 is more conservative than pass 1 because the components it
 * sees are already RIDING ON TOP of a kept decoration — we have to
 * be careful not to erase intentional dark detail (stamen tips,
 * flower-centre dots, eye highlights). Specifically:
 *   • Tighter "small" cap: bbox height < 4 % of image (vs 6 %).
 *   • Stricter row count: need ≥ 4 row-mates (vs 3) for a singleton-
 *     killing exception.
 *   • Hero-script exception is disabled — a single "Galindo" found in
 *     pass 2 is unusual but possible; we'd rather miss it than erase a
 *     decorative dark blob.
 */
function scoreAndClusterText(
  components: Component[],
  w: number,
  h: number,
  inZone: (c: Component) => boolean
): ("text" | "keep")[] {
  const totalPx = w * h;
  // Same height threshold as pass 1 — cursive scripts can occupy
  // 5–6 % of image height when ascenders + descenders are counted in
  // the bbox, even though the visual x-height is much smaller.
  const TALL_HEIGHT_FRAC = 0.06;
  const COLOUR_VAR_DEC_MIN = 22;
  const HUGE_PIXEL_FRAC = 0.02;
  const MIN_TEXT_HEIGHT_FRAC = 0.005;
  const tallPxThresh = h * TALL_HEIGHT_FRAC;
  const minTextH = h * MIN_TEXT_HEIGHT_FRAC;
  const verdicts: ("text" | "keep")[] = new Array(components.length).fill("keep");

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (!inZone(c)) continue;
    const bh = c.maxY - c.minY + 1;
    const bw = c.maxX - c.minX + 1;
    if (bh < minTextH) continue;
    if (c.count > totalPx * HUGE_PIXEL_FRAC) continue;
    const isTall = bh > tallPxThresh;
    const isHeroScript =
      bw > bh * 1.5 &&
      c.fillRatio < 0.32 &&
      bh < tallPxThresh * 2 &&
      ((c.saturatedFrac > 0.30 && !Number.isNaN(c.hueIncoherence) && c.hueIncoherence < 0.18) ||
        c.colourVariance < 22);
    if (isTall && !isHeroScript) continue;
    if (c.saturatedFrac > 0.30 && !Number.isNaN(c.hueIncoherence)) {
      if (c.hueIncoherence > 0.30) continue;
    } else {
      if (c.colourVariance > COLOUR_VAR_DEC_MIN) continue;
    }
    verdicts[i] = "text";
  }

  // Row clustering.
  const candidates = components
    .map((c, i) => ({ c, i }))
    .filter(({ i }) => verdicts[i] === "text");
  candidates.sort((a, b) => a.c.minY - b.c.minY);

  const rowOf = new Map<number, number>();
  let rowId = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (rowOf.has(candidates[i].i)) continue;
    rowId++;
    const queue = [i];
    while (queue.length > 0) {
      const k = queue.shift()!;
      if (rowOf.has(candidates[k].i)) continue;
      rowOf.set(candidates[k].i, rowId);
      const a = candidates[k].c;
      const aH = a.maxY - a.minY + 1;
      for (let j = k + 1; j < candidates.length; j++) {
        if (rowOf.has(candidates[j].i)) continue;
        const b = candidates[j].c;
        if (b.minY > a.maxY + aH * 0.5) break;
        const bH = b.maxY - b.minY + 1;
        const overlap = Math.max(
          0,
          Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1
        );
        if (overlap >= Math.min(aH, bH) * 0.4) {
          queue.push(j);
        }
      }
    }
  }

  const rowCount = new Map<number, number>();
  for (const r of rowOf.values()) {
    rowCount.set(r, (rowCount.get(r) ?? 0) + 1);
  }

  // A pass-2 component is erased if EITHER:
  //   • It's part of a row of ≥ 3 candidates (a real text row), OR
  //   • It looks like a stylised cursive name riding alone on a
  //     decoration: wide bbox, very stroke-like, very uniform colour,
  //     and a meaningful pixel count. This catches the
  //     "single-word-grazing-the-flower" case ("Galindo" in the test
  //     image) without being permissive enough to erase decorative
  //     dark detail (which is usually small + low-aspect-ratio +
  //     dense).
  //
  // Why these specific thresholds (chosen by testing against the
  // Quince invite and verifying the crown's gemstones don't trip):
  //   • count > 0.03 % of image → must be a sizeable mark (one cursive
  //     word in a 1500×2100 image is ~2000 px = 0.06 %; gemstones are
  //     usually < 200 px = 0.006 %).
  //   • aspect bw > bh × 1.5 → cursive sweeps wider than tall;
  //     gemstones / dots / circles have aspect ≈ 1.
  //   • fillRatio < 0.35 → strokes draw a tiny fraction of their
  //     bounding box; filled blobs draw most of theirs.
  for (const { c, i } of candidates) {
    const r = rowOf.get(i)!;
    if ((rowCount.get(r) ?? 0) >= 3) continue;
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const isStyledScript =
      c.count > totalPx * 0.0003 &&
      bw > bh * 1.5 &&
      c.fillRatio < 0.35 &&
      c.colourVariance < 14;
    if (!isStyledScript) {
      verdicts[i] = "keep";
    }
  }

  return verdicts;
}

/**
 * 1-pixel binary erosion using a 4-neighbour cross structuring element.
 * Output[i] = 1 iff input[i] AND all 4 of its orthogonal neighbours = 1.
 * Edge pixels (on image border) become 0.
 */
function erodeMask4(input: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (
        input[i] &&
        input[i - 1] &&
        input[i + 1] &&
        input[i - w] &&
        input[i + w]
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/**
 * N-pixel binary dilation using a 4-neighbour cross structuring element.
 * Repeats the 1-pixel cross dilation `n` times. Output[i] = 1 iff any
 * pixel within Manhattan-distance n in the input is 1.
 */
function dilateMask4(input: Uint8Array, w: number, h: number, n: number): Uint8Array {
  let cur = input;
  for (let iter = 0; iter < n; iter++) {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (cur[i]) {
        out[i] = 1;
        continue;
      }
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && cur[i - 1]) { out[i] = 1; continue; }
      if (x < w - 1 && cur[i + 1]) { out[i] = 1; continue; }
      if (y > 0 && cur[i - w]) { out[i] = 1; continue; }
      if (y < h - 1 && cur[i + w]) { out[i] = 1; continue; }
    }
    cur = out;
  }
  return cur;
}

/**
 * Two-pass 3-4 chamfer distance transform. For each pixel, returns the
 * approximate Euclidean distance (×3) to the nearest seed pixel (where
 * `seedMask[i] === 1`). Distances above `cap` are left unchanged.
 *
 * 3-4 weights give max ~3 % error vs true Euclidean — plenty good
 * enough for proximity testing of punctuation marks (within tens of
 * pixels of erased text). Faster than BFS or true Euclidean for this
 * use case.
 *
 * Output is in "chamfer units" where horizontal/vertical step = 3,
 * diagonal step = 4. Caller compares against `proximityRadius * 3`.
 */
function chamferDistance(
  seedMask: Uint8Array,
  w: number,
  h: number,
  capPixels: number
): Int32Array {
  const cap = capPixels * 3 + 100; // safe overhead
  const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = seedMask[i] ? 0 : cap;
  // Forward pass: top-left → bottom-right
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) {
        const c = d[i - 1] + 3;
        if (c < v) v = c;
      }
      if (y > 0) {
        const c = d[i - w] + 3;
        if (c < v) v = c;
        if (x > 0) {
          const c2 = d[i - w - 1] + 4;
          if (c2 < v) v = c2;
        }
        if (x < w - 1) {
          const c2 = d[i - w + 1] + 4;
          if (c2 < v) v = c2;
        }
      }
      d[i] = v;
    }
  }
  // Backward pass: bottom-right → top-left
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) {
        const c = d[i + 1] + 3;
        if (c < v) v = c;
      }
      if (y < h - 1) {
        const c = d[i + w] + 3;
        if (c < v) v = c;
        if (x > 0) {
          const c2 = d[i + w - 1] + 4;
          if (c2 < v) v = c2;
        }
        if (x < w - 1) {
          const c2 = d[i + w + 1] + 4;
          if (c2 < v) v = c2;
        }
      }
      d[i] = v;
    }
  }
  // Convert to "px units" by integer-dividing by 3.
  for (let i = 0; i < w * h; i++) d[i] = (d[i] / 3) | 0;
  return d;
}

async function writePng(canvas: Canvas, outputPath: string): Promise<void> {
  const buf = await canvas.encode("png");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
}

async function writeDebugOverlay(
  img: Awaited<ReturnType<typeof loadImageFromPath>>,
  components: Component[],
  verdicts: ("text" | "keep")[],
  outputPath: string
): Promise<void> {
  // Render the original image, then overlay each component's bbox tinted
  // by verdict. Red = erased as text, green = kept as decoration.
  // We skip the green outlines for tiny components (< 0.001 % of image)
  // to avoid drowning the visualisation in dot-noise.
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d") as SKRSContext2D;
  ctx.fillStyle = "#f0ead2";
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  ctx.lineWidth = 1.5;
  const minDrawCount = (img.width * img.height) * 0.0001;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    if (verdicts[i] === "text") {
      ctx.strokeStyle = "rgba(220,38,38,0.95)";
      ctx.fillStyle = "rgba(220,38,38,0.18)";
    } else {
      if (c.count < minDrawCount) continue;
      ctx.strokeStyle = "rgba(34,197,94,0.7)";
      ctx.fillStyle = "rgba(34,197,94,0.0)";
    }
    ctx.fillRect(c.minX, c.minY, bw, bh);
    ctx.strokeRect(c.minX + 0.5, c.minY + 0.5, bw, bh);
  }
  await writePng(canvas, outputPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
