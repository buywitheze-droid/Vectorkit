/**
 * Real-world test harness for the screenshot extractor.
 *
 * Loads every JPG from B:/Downloads/Shapes (the user's actual phone
 * screenshots of acrylic-invite PNGs), runs the extractor, and writes:
 *
 *   test/output/screenshot/
 *     <name>_01_input.png             — the original (re-saved as PNG)
 *     <name>_02_checker_overlay.png   — input with the detected checker
 *                                       region tinted red, the design
 *                                       crop box drawn green; visualises
 *                                       what the algorithm "saw"
 *     <name>_03_cropped.png           — after cropping out phone chrome
 *     <name>_04_extracted.png         — final transparent PNG
 *
 *   npx tsx test/screenshot-extract-regression.ts
 *
 * For each input we print a one-line summary:
 *   ✓  <name>  checker(L=#xx D=#xx cell=N)  crop=WxH→WxH  removed=Npx (M%)
 *   ✗  <name>  no checker detected (image routed to chromakey instead)
 *
 * The success criterion is binary per file: did the extractor produce a
 * usable transparent PNG, or did it fail in a way that would frustrate
 * the user (over-erased the design, missed the checker entirely, cropped
 * inside the design, etc.)? You evaluate that visually by opening the
 * `_04_extracted.png` files.
 */
import "./setup.js";
import { createCanvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectCheckerboard,
  detectDesignBoundingBox,
  removeCheckerboard,
  type CheckerSpec,
  type DesignBox,
} from "../src/lib/image/screenshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SHAPES_DIR = "B:\\Downloads\\Shapes";
const OUT_DIR = resolve(__dirname, "output", "screenshot");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const hex = (c: { r: number; g: number; b: number }) =>
  "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("");

async function loadAsCanvas(path: string) {
  const img = await napiLoadImage(path);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return c;
}

function savePng(c: import("@napi-rs/canvas").Canvas, path: string) {
  // @ts-expect-error toBuffer overload
  writeFileSync(path, c.toBuffer("image/png"));
}

/**
 * Build a debug overlay: the original image with the detected checker
 * pixels tinted red and the crop box drawn as a green rectangle.
 * Lets us SEE what the algorithm classified.
 */
function buildOverlay(
  source: import("@napi-rs/canvas").Canvas,
  checker: CheckerSpec,
  box: DesignBox
) {
  const w = source.width;
  const h = source.height;
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;
  const tol = 24;
  const tolSq = tol * tol;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dL =
        (r - checker.light.r) ** 2 +
        (g - checker.light.g) ** 2 +
        (b - checker.light.b) ** 2;
      const dD =
        (r - checker.dark.r) ** 2 +
        (g - checker.dark.g) ** 2 +
        (b - checker.dark.b) ** 2;
      if (dL <= tolSq || dD <= tolSq) {
        // Tint red 50/50.
        data[i] = Math.min(255, Math.round(r * 0.4 + 255 * 0.6));
        data[i + 1] = Math.round(g * 0.4);
        data[i + 2] = Math.round(b * 0.4);
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  // Draw crop box.
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 250));
  ctx.strokeStyle = "#00ff00";
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  return out;
}

async function processOne(filePath: string) {
  const name = basename(filePath, extname(filePath));
  const source = await loadAsCanvas(filePath);
  const inputW = source.width;
  const inputH = source.height;

  // Mirror the input as PNG for easy comparison.
  savePng(source, resolve(OUT_DIR, `${name}_01_input.png`));

  // @ts-expect-error napi-canvas vs HTMLCanvasElement signature
  const checker = detectCheckerboard(source);
  if (!checker) {
    console.log(
      `  ✗  ${name.padEnd(40)}  no checker detected (route to chromakey)`
    );
    return { name, ok: false, reason: "no-checker" as const };
  }

  // @ts-expect-error napi-canvas vs HTMLCanvasElement signature
  const box = detectDesignBoundingBox(source, checker);

  // Build & save the debug overlay BEFORE cropping.
  const overlay = buildOverlay(source, checker, box);
  savePng(overlay, resolve(OUT_DIR, `${name}_02_checker_overlay.png`));

  // Crop manually here so we can save the intermediate.
  const cropped = createCanvas(box.width, box.height);
  cropped
    .getContext("2d")
    .drawImage(
      source,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      box.width,
      box.height
    );
  savePng(cropped, resolve(OUT_DIR, `${name}_03_cropped.png`));

  // @ts-expect-error napi-canvas vs HTMLCanvasElement signature
  const { canvas: extracted, pixelsRemoved } = removeCheckerboard(cropped, checker);
  savePng(
    extracted as unknown as import("@napi-rs/canvas").Canvas,
    resolve(OUT_DIR, `${name}_04_extracted.png`)
  );

  const totalPx = box.width * box.height;
  const removedPct = (pixelsRemoved / totalPx) * 100;

  console.log(
    `  ✓  ${name.padEnd(40)}  ` +
      `checker(L=${hex(checker.light)} D=${hex(checker.dark)} cell=${checker.cellSize}px conf=${checker.confidence.toFixed(2)})  ` +
      `crop ${inputW}x${inputH}→${box.width}x${box.height}  ` +
      `removed=${pixelsRemoved.toLocaleString()}px (${removedPct.toFixed(1)}%)`
  );

  return { name, ok: true, removedPct };
}

async function run() {
  if (!existsSync(SHAPES_DIR)) {
    console.error(`[FATAL] Shapes folder not found: ${SHAPES_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(SHAPES_DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => join(SHAPES_DIR, f))
    .filter((p) => statSync(p).isFile());

  console.log(`Running screenshot extractor against ${files.length} real samples…\n`);

  const results: Array<{ name: string; ok: boolean }> = [];
  for (const f of files) {
    try {
      const r = await processOne(f);
      results.push(r);
    } catch (e) {
      console.log(`  💥  ${basename(f).padEnd(40)}  ERROR: ${(e as Error).message}`);
      results.push({ name: basename(f), ok: false });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const noChecker = results.filter((r) => !r.ok).length;
  console.log(`\nDone — ${ok}/${results.length} extracted, ${noChecker} not-a-checker.`);
  console.log(`Outputs: ${OUT_DIR}`);
}

run();
