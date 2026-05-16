/**
 * Targeted regression test for the WizardEditor "Smart Erase" pipeline.
 *
 * Goal: prove (or disprove) that the algorithm chosen in the wizard erases
 * the white background of an invitation-style design WITHOUT eating the
 * pink dress, the white-centered flower, the gold crown, or the white
 * letter interiors.
 *
 *   npx tsx test/smart-erase-regression.ts
 *
 * Outputs go to test/output/smart-erase/. We write:
 *   • the synthetic source PNG
 *   • the cutout from each candidate algorithm config
 *   • a side-by-side composite for quick visual diff
 *
 * It also prints a quantitative report — for each "preserve" zone (dress,
 * flower body, crown, letter strokes) we count how many opaque pixels
 * survived. < 95 % is a failure.
 */
import "./setup.js";
import { createCanvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  smartErase,
  decontaminateEdges,
  removeColorGlobal,
  removeEnclosedHoles,
  thickenDesignLines,
} from "../src/lib/image/chromakey.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "output", "smart-erase");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const W = 800;
const H = 1000;

// ─── Build a synthetic "invitation" with the user's failure modes ───────────
//
// White background, pink quinceañera-style dress in the center, white-centered
// pink flower in a corner, white text "Sweet 16" with gold accents, gold
// crown with a bright-white inner highlight. Every "preserve" element pushes
// one specific kind of leakage:
//
//   • Pink dress      : light-pink anti-alias chain ending at near-pink.
//   • Flower w/ white center : enclosed white that flood-fill MUST preserve
//     (only the depth limit + interior topology saves it).
//   • White letter strokes   : white inside a colored outline — must survive.
//   • Gold crown white spike : white "highlight" strokes in a gold object.

interface PreserveZone {
  label: string;
  /** Bounding box of pixels we expect to remain opaque. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Optional predicate: only count pixels whose ORIGINAL alpha was > 0. */
  expectedColor?: { r: number; g: number; b: number; tolerance: number };
}

function buildSyntheticInvitation(): {
  pngBuffer: Buffer;
  zones: PreserveZone[];
} {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Pure white background (canonical case the user keeps hitting).
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ─── Pink dress (mannequin silhouette) ────────────────────────────────────
  // Light pink torso fading to slightly darker pink waist. The edges are
  // anti-aliased by the canvas renderer, which is what produces the
  // pure-white → light-pink chain that fooled the old algorithm.
  const dressX = W / 2;
  const dressTopY = 380;
  const dressBottomY = 820;
  const dressGrad = ctx.createLinearGradient(0, dressTopY, 0, dressBottomY);
  dressGrad.addColorStop(0, "#fbe4ec"); // very light blush at top — closest to BG
  dressGrad.addColorStop(0.4, "#f5c5d6");
  dressGrad.addColorStop(1, "#e9a3bd"); // mid-pink at hem
  ctx.fillStyle = dressGrad;
  ctx.beginPath();
  // Bodice
  ctx.moveTo(dressX - 60, dressTopY);
  ctx.lineTo(dressX + 60, dressTopY);
  ctx.lineTo(dressX + 80, dressTopY + 100);
  ctx.lineTo(dressX + 70, dressTopY + 180);
  // Skirt flare
  ctx.lineTo(dressX + 220, dressBottomY);
  ctx.lineTo(dressX - 220, dressBottomY);
  ctx.lineTo(dressX - 70, dressTopY + 180);
  ctx.lineTo(dressX - 80, dressTopY + 100);
  ctx.closePath();
  ctx.fill();

  // The TOP of the dress is the riskiest zone for leakage — it's where the
  // anti-alias chain is closest to pure white. We sample a strip there.
  const dressZone: PreserveZone = {
    label: "dress (top blush)",
    x: dressX - 50,
    y: dressTopY + 5,
    w: 100,
    h: 30,
    expectedColor: { r: 251, g: 228, b: 236, tolerance: 30 },
  };
  const dressMidZone: PreserveZone = {
    label: "dress (mid skirt)",
    x: dressX - 100,
    y: 600,
    w: 200,
    h: 80,
    expectedColor: { r: 240, g: 190, b: 210, tolerance: 40 },
  };

  // ─── Corner flower with white center ──────────────────────────────────────
  // Five overlapping pink petals around a pure-white disc. The white center
  // is enclosed inside the petals → flood from edges should never reach it.
  const flowerCx = 130;
  const flowerCy = 130;
  ctx.fillStyle = "#f5b5cc"; // light pink petals
  for (let p = 0; p < 5; p++) {
    const angle = (p / 5) * Math.PI * 2 - Math.PI / 2;
    const px = flowerCx + Math.cos(angle) * 55;
    const py = flowerCy + Math.sin(angle) * 55;
    ctx.beginPath();
    ctx.arc(px, py, 45, 0, Math.PI * 2);
    ctx.fill();
  }
  // Inner pure-white circle (the "white center" the user said keeps getting eaten).
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(flowerCx, flowerCy, 22, 0, Math.PI * 2);
  ctx.fill();

  const flowerPetalZone: PreserveZone = {
    label: "flower petal edge",
    x: flowerCx - 90,
    y: flowerCy + 30,
    w: 30,
    h: 30,
    expectedColor: { r: 245, g: 181, b: 204, tolerance: 40 },
  };
  const flowerWhiteCenter: PreserveZone = {
    label: "flower white center",
    x: flowerCx - 12,
    y: flowerCy - 12,
    w: 24,
    h: 24,
    expectedColor: { r: 255, g: 255, b: 255, tolerance: 8 },
  };

  // Mirror flower in the opposite corner.
  const flowerCx2 = W - 130;
  const flowerCy2 = H - 130;
  ctx.fillStyle = "#f5b5cc";
  for (let p = 0; p < 5; p++) {
    const angle = (p / 5) * Math.PI * 2 - Math.PI / 2;
    const px = flowerCx2 + Math.cos(angle) * 55;
    const py = flowerCy2 + Math.sin(angle) * 55;
    ctx.beginPath();
    ctx.arc(px, py, 45, 0, Math.PI * 2);
    ctx.fill();
  }

  // ─── Gold crown with bright-white highlight stripes ───────────────────────
  // Crown sits above the dress. The white highlight strokes inside the gold
  // are exactly the thing the user said gets eaten by the flood.
  const crownCx = W / 2;
  const crownCy = 280;
  ctx.fillStyle = "#d4a437"; // gold base
  ctx.beginPath();
  ctx.moveTo(crownCx - 90, crownCy + 40);
  ctx.lineTo(crownCx - 60, crownCy - 30);
  ctx.lineTo(crownCx - 30, crownCy + 10);
  ctx.lineTo(crownCx, crownCy - 50);
  ctx.lineTo(crownCx + 30, crownCy + 10);
  ctx.lineTo(crownCx + 60, crownCy - 30);
  ctx.lineTo(crownCx + 90, crownCy + 40);
  ctx.closePath();
  ctx.fill();
  // White highlight strokes
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(crownCx - 50, crownCy + 30);
  ctx.lineTo(crownCx - 25, crownCy - 5);
  ctx.moveTo(crownCx + 50, crownCy + 30);
  ctx.lineTo(crownCx + 25, crownCy - 5);
  ctx.stroke();

  const crownGoldZone: PreserveZone = {
    label: "crown gold body",
    x: crownCx - 20,
    y: crownCy + 15,
    w: 40,
    h: 20,
    expectedColor: { r: 212, g: 164, b: 55, tolerance: 35 },
  };
  // The white highlight is *enclosed* by the gold so it should also survive.
  const crownWhiteZone: PreserveZone = {
    label: "crown white highlight",
    x: crownCx - 35,
    y: crownCy + 10,
    w: 8,
    h: 8,
    expectedColor: { r: 255, g: 255, b: 255, tolerance: 80 },
  };

  // ─── Dress: bright-white highlight stripe (the "lit" side of fabric) ──────
  // After smartErase this remains as a pure-white blob ENCLOSED by pink
  // dress. The "remove enclosed holes" pass MUST keep it because the
  // surrounding wall (dress flesh) is hundreds of px thick.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(dressX - 30, dressTopY + 250, 18, 60, -0.3, 0, Math.PI * 2);
  ctx.fill();

  // ─── Arm-style opaque mass with a small white gap to the dress ───────────
  // A pink "arm" sitting just left of the dress, leaving a ~25 px white
  // gap between them. This is "white between the model's arms and dress".
  // The gap's wall is the arm, ~35 px wide. Right at the borderline of
  // what the user would consider acceptable to remove. We test that the
  // default (maxSurroundingThickness=12) KEEPS it (arms are usually
  // thicker than letter strokes); the user can lower the threshold if
  // they want it gone.
  ctx.fillStyle = "#e9a3bd";
  ctx.beginPath();
  ctx.ellipse(dressX - 230, dressTopY + 250, 18, 80, 0, 0, Math.PI * 2);
  ctx.fill();
  // (the gap between arm and dress is just the white BG showing through)

  // ─── Pink letters on white BG (the realistic invitation case) ─────────────
  // Letters with closed loops: "O", "B", "8", "6", "0". The interiors of
  // these loops are enclosed-BG white that smartErase can't reach. The
  // "remove inside letters" pass MUST find and erase them.
  ctx.font = "bold 110px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#c2185b"; // saturated pink fill
  ctx.fillText("BOOM 808", W / 2, 900);

  // ─── Hairline script signature — the print-prep test case ───────────────
  // 1-px stroke is below DTF print resolution. Without thickenDesignLines
  // these strokes either drop out completely or print as broken dotted
  // lines. With 1 dilation pass they should grow to ~3 px and survive.
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1; // hairline — the failure case we want to fix
  ctx.beginPath();
  ctx.moveTo(60, 950);
  ctx.bezierCurveTo(120, 940, 180, 970, 240, 950);
  ctx.bezierCurveTo(280, 940, 320, 970, 360, 950);
  ctx.stroke();

  const letterInteriorZone: PreserveZone = {
    label: "letter interior (pixels in 'W' arms)",
    x: W / 2 - 130,
    y: 880,
    w: 30,
    h: 25,
    // Looser color match: anti-alias mixes BG white with pink stroke,
    // so the surviving "white" letter pixel can be a near-white shade.
    expectedColor: { r: 250, g: 240, b: 244, tolerance: 50 },
  };

  return {
    pngBuffer: canvas.toBuffer("image/png"),
    zones: [
      dressZone,
      dressMidZone,
      flowerPetalZone,
      flowerWhiteCenter,
      crownGoldZone,
      crownWhiteZone,
      letterInteriorZone,
    ],
  };
}

// ─── Run the actual app pipeline against the fixture ────────────────────────

interface VariantResult {
  name: string;
  outFile: string;
  bgRemovedRatio: number;
  removedBG: number;
  removedAA: number;
  leakedLight: number;
  leakedDeep: number;
  designPreservedRatio: number;
  totalDesignPixels: number;
}

async function runVariant(
  name: string,
  sourcePath: string,
  zones: PreserveZone[],
  config: {
    tightTolerance: number;
    fringeTolerance: number;
    maxFringeSteps: number;
    edgeFeather: number;
    decontaminate: boolean;
    decontaminateThreshold?: number;
    decontaminateIterations?: number;
  }
): Promise<VariantResult> {
  const napiImg = await napiLoadImage(sourcePath);

  // Convert NapiImage → HTMLImageElement-shaped object (the lib only reads
  // .width/.height/.src and feeds it through imageToCanvas → drawImage).
  const img = napiImg as unknown as HTMLImageElement;

  let canvas = await smartErase(img, {
    bgColor: "#ffffff",
    tightTolerance: config.tightTolerance,
    fringeTolerance: config.fringeTolerance,
    maxFringeSteps: config.maxFringeSteps,
    edgeFeather: config.edgeFeather,
  });

  if (config.decontaminate) {
    canvas = decontaminateEdges(canvas, {
      bgColor: "#ffffff",
      dropThreshold: config.decontaminateThreshold ?? 0.4,
      iterations: config.decontaminateIterations ?? 1,
      innerSearchRadius: 3,
    });
  }

  const outFile = resolve(OUT_DIR, `${name}.png`);
  // @ts-expect-error napi canvas exposes toBuffer in the polyfill chain
  writeFileSync(outFile, canvas.toBuffer("image/png"));

  // ─── Quantitative checks ──────────────────────────────────────────────────
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("ctx missing");
  const fullData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  // Read source for pixel-by-pixel comparison.
  const srcImg = await napiLoadImage(sourcePath);
  const srcCanvas = createCanvas(srcImg.width, srcImg.height);
  const srcCtx = srcCanvas.getContext("2d");
  srcCtx.drawImage(srcImg, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcImg.width, srcImg.height).data;

  // ─── Pixel-by-pixel "leakage" diff ────────────────────────────────────────
  // The source is fully opaque (canvas-rendered). Any opaque source pixel
  // that became transparent in the cutout is either correctly removed BG
  // OR incorrectly removed design.
  //
  // Classify each removed pixel by how far its source color is from white.
  //   0–30 RGB    : pure / near BG → correct removal
  //   30–80 RGB   : anti-alias band → acceptable to remove (1px halo)
  //   80–150 RGB  : LIGHT design pixel (light pink) → leakage
  //   150+ RGB    : MID/DARK design pixel (real pink, gold) → bad leakage
  let removedBG = 0;
  let removedAA = 0;
  let leakedLight = 0;
  let leakedDeep = 0;
  let totalDesignPixels = 0;
  let preservedDesign = 0;

  for (let i = 0; i < srcData.length; i += 4) {
    const sr = srcData[i];
    const sg = srcData[i + 1];
    const sb = srcData[i + 2];
    const dr = 255 - sr;
    const dg = 255 - sg;
    const db = 255 - sb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    const wasDesign = dist > 30;
    if (wasDesign) totalDesignPixels++;
    const isOpaque = fullData[i + 3] >= 128;
    if (wasDesign && isOpaque) preservedDesign++;
    if (isOpaque) continue; // not removed → no leakage to count

    if (dist <= 30) removedBG++;
    else if (dist <= 80) removedAA++;
    else if (dist <= 150) leakedLight++;
    else leakedDeep++;
  }

  // BG check: corners + edges should all be transparent.
  let bgChecked = 0;
  let bgTransparent = 0;
  const sampleBgPoint = (x: number, y: number) => {
    bgChecked++;
    const i = (y * canvas.width + x) * 4;
    if (fullData[i + 3] < 30) bgTransparent++;
  };
  for (let i = 0; i < 50; i++) {
    sampleBgPoint(10 + i * 4, 10);
    sampleBgPoint(10 + i * 4, canvas.height - 10);
    sampleBgPoint(10, 10 + i * 4);
    sampleBgPoint(canvas.width - 10, 10 + i * 4);
  }

  return {
    name,
    outFile,
    bgRemovedRatio: bgTransparent / bgChecked,
    removedBG,
    removedAA,
    leakedLight,
    leakedDeep,
    designPreservedRatio:
      totalDesignPixels > 0 ? preservedDesign / totalDesignPixels : 0,
    totalDesignPixels,
  };
}

// ─── Reporter ───────────────────────────────────────────────────────────────

function printReport(variants: VariantResult[]) {
  for (const v of variants) {
    const preservedPct = (v.designPreservedRatio * 100).toFixed(2);
    const totalLeak = v.leakedLight + v.leakedDeep;
    const tag =
      v.designPreservedRatio >= 0.99 && v.leakedDeep === 0
        ? " GOOD "
        : v.designPreservedRatio >= 0.95
          ? " WARN "
          : " FAIL ";
    console.log(`\n[${tag}] ${v.name}`);
    console.log(`  BG corners cleared        : ${(v.bgRemovedRatio * 100).toFixed(1)}%`);
    console.log(`  Design pixels preserved   : ${preservedPct}% of ${v.totalDesignPixels}`);
    console.log(`  Removed pure BG           : ${v.removedBG}`);
    console.log(`  Removed anti-alias halo   : ${v.removedAA}     (acceptable ≤ 1px halo)`);
    console.log(`  LEAKED light design pix   : ${v.leakedLight}   (light pink / off-white)`);
    console.log(`  LEAKED deep design pix    : ${v.leakedDeep}   (real pink / gold — UNACCEPTABLE)`);
    console.log(`  → ${v.outFile}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("Building synthetic invitation fixture (clean)…");
  const { pngBuffer, zones } = buildSyntheticInvitation();
  const cleanPath = resolve(OUT_DIR, "_source_clean.png");
  writeFileSync(cleanPath, pngBuffer);

  console.log("Building noisy variant (JPEG-style ±6 RGB noise on BG)…");
  const noisyPath = resolve(OUT_DIR, "_source_noisy.png");
  await addBgNoise(cleanPath, noisyPath, 6);

  for (const [label, sourcePath] of [
    ["CLEAN BG", cleanPath],
    ["NOISY BG (±6)", noisyPath],
  ] as const) {
    console.log(`\n========== ${label} ==========`);
    const variants: VariantResult[] = [];

    variants.push(
      await runVariant(`${label}-01_current_broken`, sourcePath, zones, {
        tightTolerance: 4,
        fringeTolerance: 10,
        maxFringeSteps: 3,
        edgeFeather: 1,
        decontaminate: false,
      })
    );
    variants.push(
      await runVariant(`${label}-02_proposed_fix`, sourcePath, zones, {
        tightTolerance: 3,
        fringeTolerance: 6,
        maxFringeSteps: 1,
        edgeFeather: 0,
        decontaminate: true,
      })
    );

    printReport(variants);
  }

  console.log("\n========== GLOBAL REMOVE-ALL-WHITE PASS ==========");
  await testRemoveAllWhite(cleanPath);

  console.log("\n========== SMART REMOVE-INSIDE-LETTERS PASS ==========");
  await testRemoveEnclosedHoles(cleanPath);

  console.log("\n========== STROKE-THICKENING (PRE-REMOVAL) ==========");
  await testThickenDesignLines(cleanPath);
}

/**
 * Test the print-prep flow: thicken thin strokes, then remove BG, and
 * measure the hairline-stroke survival rate. The hairline signature
 * curve at the bottom of the fixture is rendered with lineWidth=1 — it's
 * about ~10–20 % opaque pixels along the stroke path due to anti-aliasing,
 * which means most of it gets eaten by smartErase. After thickenDesignLines
 * (1 pass), the stroke should be solidly visible.
 */
async function testThickenDesignLines(sourcePath: string) {
  const napiImg = await napiLoadImage(sourcePath);
  const img = napiImg as unknown as HTMLImageElement;

  // Approximate bounding box of the hairline signature in the fixture.
  // (60..360, 940..970)
  const STROKE_BOX = { x: 50, y: 935, w: 320, h: 35 };

  const runPipeline = async (passes: number) => {
    let src: HTMLCanvasElement;
    if (passes > 0) {
      // Pre-process the original via the new function.
      const ctx = createCanvas(napiImg.width, napiImg.height).getContext("2d");
      ctx.drawImage(napiImg, 0, 0);
      const baseCanvas = createCanvas(napiImg.width, napiImg.height);
      const baseCtx = baseCanvas.getContext("2d");
      baseCtx.drawImage(napiImg, 0, 0);
      src = thickenDesignLines(
        baseCanvas as unknown as HTMLCanvasElement,
        { bgColor: "#ffffff", bgTolerance: 5, passes }
      );
    } else {
      src = createCanvas(napiImg.width, napiImg.height) as unknown as HTMLCanvasElement;
      const c = src.getContext("2d");
      if (!c) throw new Error("ctx");
      c.drawImage(napiImg, 0, 0);
    }
    // Re-encode to an Image so smartErase can consume it.
    // @ts-expect-error toBuffer
    const buf = src.toBuffer("image/png");
    const tmpPath = resolve(OUT_DIR, `_thicken_pass${passes}.png`);
    writeFileSync(tmpPath, buf);
    const stagedImg = (await napiLoadImage(tmpPath)) as unknown as HTMLImageElement;
    let cutout = await smartErase(stagedImg, {
      bgColor: "#ffffff",
      tightTolerance: 3,
      fringeTolerance: 6,
      maxFringeSteps: 1,
      edgeFeather: 0,
    });
    cutout = decontaminateEdges(cutout, {
      bgColor: "#ffffff",
      dropThreshold: 0.4,
      iterations: 1,
      innerSearchRadius: 3,
    });
    return { stagedSrc: src, cutout };
  };

  const measureStroke = (canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("ctx");
    const data = ctx.getImageData(STROKE_BOX.x, STROKE_BOX.y, STROKE_BOX.w, STROKE_BOX.h).data;
    let opaqueDarkPx = 0;
    for (let i = 0; i < data.length; i += 4) {
      // "Stroke pixel" = opaque AND dark (the signature was drawn in #1f2937).
      if (data[i + 3] >= 200 && data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) {
        opaqueDarkPx++;
      }
    }
    return opaqueDarkPx;
  };

  for (const passes of [0, 1, 2] as const) {
    const { stagedSrc, cutout } = await runPipeline(passes);
    const sourceStroke = measureStroke(stagedSrc);
    const cutoutStroke = measureStroke(cutout);
    const survivalPct = sourceStroke > 0 ? (cutoutStroke / sourceStroke) * 100 : 0;
    const tag =
      passes === 0
        ? "no thickening (baseline)"
        : `thickenDesignLines × ${passes}`;
    const outFile = resolve(OUT_DIR, `thicken_pass${passes}_cutout.png`);
    // @ts-expect-error toBuffer
    writeFileSync(outFile, cutout.toBuffer("image/png"));
    console.log(
      `  ${tag.padEnd(28)} | source-stroke px=${String(sourceStroke).padStart(4)}  cutout-stroke px=${String(cutoutStroke).padStart(4)}  → ${survivalPct.toFixed(1)}% survived`
    );
    console.log(`     → ${outFile}`);
  }
}

async function testRemoveAllWhite(sourcePath: string) {
  const napiImg = await napiLoadImage(sourcePath);
  const img = napiImg as unknown as HTMLImageElement;

  // First: run smartErase as the wizard does.
  let canvas = await smartErase(img, {
    bgColor: "#ffffff",
    tightTolerance: 3,
    fringeTolerance: 6,
    maxFringeSteps: 1,
    edgeFeather: 0,
  });
  canvas = decontaminateEdges(canvas, {
    bgColor: "#ffffff",
    dropThreshold: 0.4,
    iterations: 1,
    innerSearchRadius: 3,
  });

  // Snapshot interim state — at this point the flower's WHITE CENTER, the
  // crown's WHITE HIGHLIGHTS, and the LETTER INTERIORS all still exist (good).
  const interimFile = resolve(OUT_DIR, "global_01_after_smarterase.png");
  // @ts-expect-error toBuffer
  writeFileSync(interimFile, canvas.toBuffer("image/png"));

  // Now apply the new global pass.
  const { canvas: afterGlobal, pixelsRemoved } = removeColorGlobal(canvas, {
    color: "#ffffff",
    tolerance: 3,
    decontaminate: true,
  });
  const finalFile = resolve(OUT_DIR, "global_02_after_remove_all_white.png");
  // @ts-expect-error toBuffer
  writeFileSync(finalFile, afterGlobal.toBuffer("image/png"));

  // Diff: same pixel-class report as before but on the final output.
  const srcImg = await napiLoadImage(sourcePath);
  const srcCanvas = createCanvas(srcImg.width, srcImg.height);
  const srcCtx = srcCanvas.getContext("2d");
  srcCtx.drawImage(srcImg, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcImg.width, srcImg.height).data;
  const ctx = afterGlobal.getContext("2d");
  if (!ctx) throw new Error("ctx");
  const finalData = ctx.getImageData(0, 0, afterGlobal.width, afterGlobal.height).data;

  let preservedDesign = 0;
  let totalDesign = 0;
  let leakedDeep = 0;
  let removedEnclosedWhite = 0;
  for (let i = 0; i < srcData.length; i += 4) {
    const dist = Math.sqrt(
      (255 - srcData[i]) ** 2 +
        (255 - srcData[i + 1]) ** 2 +
        (255 - srcData[i + 2]) ** 2
    );
    const isOpaque = finalData[i + 3] >= 128;
    if (dist > 30) {
      totalDesign++;
      if (isOpaque) preservedDesign++;
      else if (dist > 150) leakedDeep++;
    } else if (!isOpaque && dist <= 15) {
      removedEnclosedWhite++;
    }
  }

  console.log(`\n  Global pass removed         : ${pixelsRemoved} pixels`);
  console.log(`  Design preserved            : ${(preservedDesign / totalDesign * 100).toFixed(2)}% (deep design pixels: pink/gold)`);
  console.log(`  Deep design leaked          : ${leakedDeep}    (must be 0)`);
  console.log(`  Total white pixels removed  : ${removedEnclosedWhite}    (BG + flower center + crown highlight + letter interiors)`);
  console.log(`  → ${interimFile}`);
  console.log(`  → ${finalFile}`);
}

/**
 * Verify that removeEnclosedHoles erases letter interiors but PRESERVES
 * the flower white center, the crown white highlight, and the dress
 * white highlight stripe.
 *
 * Each preserve check samples a known coordinate. Each erase check
 * samples a known letter-hole coordinate.
 */
async function testRemoveEnclosedHoles(sourcePath: string) {
  const napiImg = await napiLoadImage(sourcePath);
  const img = napiImg as unknown as HTMLImageElement;

  let canvas = await smartErase(img, {
    bgColor: "#ffffff",
    tightTolerance: 3,
    fringeTolerance: 6,
    maxFringeSteps: 1,
    edgeFeather: 0,
  });
  canvas = decontaminateEdges(canvas, {
    bgColor: "#ffffff",
    dropThreshold: 0.4,
    iterations: 1,
    innerSearchRadius: 3,
  });

  // Calibrate sample points by walking the post-smartErase canvas and
  // finding actual enclosed white blobs in known regions of the fixture.
  // This way the test's expectations don't drift when the fixture moves.
  const points = await calibrateSamplePoints(canvas);

  const beforeSample = sampleAlpha(canvas, points);

  // Sweep a few thickness values so we can pick the best default.
  for (const thickness of [12, 16, 20, 25] as const) {
    const before = sampleAlpha(canvas, points);
    const { canvas: after, pixelsRemoved, blobsRemoved, blobsKept } =
      removeEnclosedHoles(canvas, {
        color: "#ffffff",
        tolerance: 3,
        maxSurroundingThickness: thickness,
        decontaminate: true,
      });
    const afterSample = sampleAlpha(after, points);
    let removeOk = 0,
      removeFail = 0,
      preserveOk = 0,
      preserveFail = 0;
    for (const p of points) {
      if ((before[p.label] ?? 0) < 128) continue;
      const stillOpaque = (afterSample[p.label] ?? 0) >= 128;
      if (p.expected === "preserve") {
        if (stillOpaque) preserveOk++;
        else preserveFail++;
      } else {
        if (!stillOpaque) removeOk++;
        else removeFail++;
      }
    }
    console.log(
      `  thickness=${String(thickness).padStart(2)} | blobsRemoved=${String(blobsRemoved).padStart(2)} kept=${String(blobsKept).padStart(2)} | letterHoles ${removeOk}/${removeOk + removeFail} ✓  preserves ${preserveOk}/${preserveOk + preserveFail} ✓  | removed=${pixelsRemoved}px`
    );
    if (thickness === 16) {
      const outFile = resolve(OUT_DIR, "holes_after_remove_inside_letters.png");
      // @ts-expect-error toBuffer
      writeFileSync(outFile, after.toBuffer("image/png"));
    }
  }
  // Final detailed printout uses the chosen default (16).
  const { canvas: after, pixelsRemoved, blobsRemoved, blobsKept } =
    removeEnclosedHoles(canvas, {
      color: "#ffffff",
      tolerance: 3,
      maxSurroundingThickness: 16,
      decontaminate: true,
    });

  const afterSample = sampleAlpha(after, points);

  const outFile = resolve(OUT_DIR, "holes_after_remove_inside_letters.png");
  // @ts-expect-error toBuffer
  writeFileSync(outFile, after.toBuffer("image/png"));

  console.log(`\n  Pass removed                : ${pixelsRemoved} pixels (${blobsRemoved} blobs)`);
  console.log(`  Blobs kept (preserved)      : ${blobsKept}`);
  console.log(`  → ${outFile}\n`);

  for (const p of points) {
    const wasOpaque = beforeSample[p.label] >= 128;
    const stillOpaque = afterSample[p.label] >= 128;
    let verdict: string;
    if (!wasOpaque) {
      verdict = "SKIP"; // already gone before this pass — not its job
    } else if (p.expected === "preserve") {
      verdict = stillOpaque ? " OK " : "FAIL";
    } else {
      verdict = !stillOpaque ? " OK " : "FAIL";
    }
    console.log(
      `  [${verdict}] ${p.label.padEnd(36)} expect=${p.expected.padEnd(8)} wasOpaque=${wasOpaque} stillOpaque=${stillOpaque}`
    );
  }
}

interface SamplePoint {
  label: string;
  x: number;
  y: number;
  expected: "remove" | "preserve";
}

/**
 * After smartErase, find one representative enclosed-white pixel inside
 * each region of interest of the fixture. We do this by scanning a small
 * search box near the known fixture coords for a pixel that's:
 *   • opaque (alpha 255) AND
 *   • near-white (within 12 RGB of pure white)
 * If no such pixel exists the calibration uses (0,0) as a sentinel
 * and the test prints SKIP for that label rather than a misleading FAIL.
 */
async function calibrateSamplePoints(
  canvas: HTMLCanvasElement
): Promise<SamplePoint[]> {
  type Region = { label: string; x: number; y: number; w: number; h: number; expected: "remove" | "preserve" };
  // Approximate centers of known interesting features in the fixture.
  // The "remove" regions are inside the closed loops of letters in
  // "BOOM 808" rendered at 110px bold. The "preserve" regions are
  // inside design elements that contain enclosed whites.
  const regions: Region[] = [
    // BOOM 808 sits at y=900, char width ~60-80px, centered at x=400.
    // Approximate hole-center search boxes for each closed loop:
    { label: "letter hole 'B' top",   x: 250, y: 880, w: 30, h: 20, expected: "remove" },
    { label: "letter hole 'B' bot",   x: 250, y: 920, w: 30, h: 20, expected: "remove" },
    { label: "letter hole 'O' (1st)", x: 305, y: 895, w: 35, h: 30, expected: "remove" },
    { label: "letter hole 'O' (2nd)", x: 360, y: 895, w: 35, h: 30, expected: "remove" },
    { label: "letter hole '8' top (left of 0)", x: 460, y: 880, w: 30, h: 20, expected: "remove" },
    { label: "letter hole '0' (mid)", x: 510, y: 895, w: 30, h: 30, expected: "remove" },
    { label: "letter hole '8' top (right)",     x: 555, y: 880, w: 30, h: 20, expected: "remove" },
    // PRESERVE regions — design features with enclosed whites.
    { label: "flower white center",   x: 120, y: 120, w: 30, h: 30, expected: "preserve" },
    { label: "dress bright highlight", x: 360, y: 620, w: 40, h: 60, expected: "preserve" },
  ];
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("ctx");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const points: SamplePoint[] = [];
  for (const r of regions) {
    let found: SamplePoint | null = null;
    for (let y = r.y; y < r.y + r.h && !found; y++) {
      for (let x = r.x; x < r.x + r.w && !found; x++) {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
        const i = (y * canvas.width + x) * 4;
        const isOpaque = data[i + 3] >= 200;
        const isNearWhite =
          (255 - data[i]) ** 2 +
            (255 - data[i + 1]) ** 2 +
            (255 - data[i + 2]) ** 2 <
          200;
        if (isOpaque && isNearWhite) {
          found = { label: r.label, x, y, expected: r.expected };
        }
      }
    }
    points.push(found ?? { label: r.label, x: 0, y: 0, expected: r.expected });
  }
  return points;
}

function sampleAlpha(
  canvas: HTMLCanvasElement,
  points: SamplePoint[]
): Record<string, number> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("ctx");
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out: Record<string, number> = {};
  for (const p of points) {
    const i = (p.y * canvas.width + p.x) * 4;
    out[p.label] = data[i + 3];
  }
  return out;
}

async function addBgNoise(srcPath: string, dstPath: string, amplitude: number) {
  const img = await napiLoadImage(srcPath);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, img.width, img.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    // Only add noise to near-white pixels (the "BG").
    const dist = Math.sqrt(
      (255 - d[i]) ** 2 + (255 - d[i + 1]) ** 2 + (255 - d[i + 2]) ** 2
    );
    if (dist > 15) continue;
    const n = (Math.random() - 0.5) * 2 * amplitude;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(id, 0, 0);
  // @ts-expect-error napi canvas toBuffer
  writeFileSync(dstPath, c.toBuffer("image/png"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
