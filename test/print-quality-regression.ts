/**
 * Visual regression for the print-render quality stack:
 *   - Lanczos-3 resample vs browser default (bilinear emulation)
 *   - Edge-aware unsharp mask
 *   - Text-colour detection (text vectorisation itself needs a real
 *     browser for potrace-plus + Path2D, so it's tested in-app)
 *
 * Outputs side-by-side comparisons to test/output/print-quality so we
 * can eyeball them.
 */
import "./setup.js";
import { createCanvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resample } from "../src/lib/image/resample.js";
import { edgeAwareSharpen } from "../src/lib/image/sharpen.js";
import { detectTextColours } from "../src/lib/image/textVectorize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "output", "screenshot");
const OUT_DIR = resolve(__dirname, "output", "print-quality");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const samples = readdirSync(SRC_DIR)
  .filter((f) => f.endsWith("_04_extracted.png"))
  .slice(0, 3);

async function processOne(file: string) {
  const p = resolve(SRC_DIR, file);
  const img = await napiLoadImage(p);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  const baseName = file.replace(/_04_extracted\.png$/, "");
  console.log(`\n${baseName}  (${img.width} × ${img.height})`);

  // Print at 5×7 @ 300 DPI = 1500×2100 canvas, fit to source aspect.
  const targetW = 1500;
  const aspect = img.height / img.width;
  const targetH = Math.round(targetW * aspect);

  // Browser-default emulation: createCanvas + drawImage scaled. napi-rs
  // uses skia under the hood which is bicubic-ish; close enough to "what
  // you'd get without our pipeline" for visual comparison.
  const naive = createCanvas(targetW, targetH);
  naive.getContext("2d").drawImage(c, 0, 0, targetW, targetH);

  const t0 = Date.now();
  // @ts-expect-error napi vs html canvas
  const lanczos = resample(c, targetW, targetH, "lanczos3");
  const tLanczos = Date.now() - t0;

  const t1 = Date.now();
  // @ts-expect-error napi vs html canvas
  const sharpened = edgeAwareSharpen(lanczos, { amount: 0.4 });
  const tSharpen = Date.now() - t1;

  // Text-colour detection on the source.
  const t2 = Date.now();
  // @ts-expect-error napi vs html canvas
  const colours = detectTextColours(c, 3);
  const tDetect = Date.now() - t2;

  console.log(
    `  resample (Lanczos-3 → ${targetW}×${targetH}): ${tLanczos} ms`
  );
  console.log(`  edge-aware sharpen           : ${tSharpen} ms`);
  console.log(
    `  detect text colours          : ${tDetect} ms → ${colours.length} candidate(s)`
  );
  for (const col of colours) {
    console.log(
      `    ${col.hex.padEnd(8)} ${col.pixels.toString().padStart(7)} px  ${String(col.components).padStart(4)} components  median height ${col.medianComponentHeight}px`
    );
  }

  // Write outputs.
  // @ts-expect-error toBuffer overload
  writeFileSync(resolve(OUT_DIR, `${baseName}__01_naive.png`), naive.toBuffer("image/png"));
  // @ts-expect-error toBuffer overload
  writeFileSync(resolve(OUT_DIR, `${baseName}__02_lanczos.png`), lanczos.toBuffer("image/png"));
  // @ts-expect-error toBuffer overload
  writeFileSync(resolve(OUT_DIR, `${baseName}__03_sharpened.png`), sharpened.toBuffer("image/png"));

  // Crop a 600×400 detail region around the text area for easier
  // eye-balling. Most invitation text sits in the middle 60 % of the
  // canvas vertically and 50 % horizontally.
  const cropX = Math.round(targetW * 0.2);
  const cropY = Math.round(targetH * 0.3);
  const cropW = 600;
  const cropH = 400;
  for (const [name, src] of [
    ["naive", naive],
    ["lanczos", lanczos],
    ["sharpened", sharpened],
  ] as const) {
    const crop = createCanvas(cropW, cropH);
    crop.getContext("2d").drawImage(
      src,
      cropX, cropY, cropW, cropH,
      0, 0, cropW, cropH
    );
    // @ts-expect-error toBuffer overload
    writeFileSync(resolve(OUT_DIR, `${baseName}__detail_${name}.png`), crop.toBuffer("image/png"));
  }
}

async function run() {
  if (samples.length === 0) {
    console.error("No extracted samples found. Run npm run test:screenshot first.");
    process.exit(1);
  }
  for (const file of samples) {
    await processOne(file);
  }
  console.log(`\nWrote outputs to ${OUT_DIR}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
