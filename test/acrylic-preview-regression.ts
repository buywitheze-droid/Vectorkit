import "./setup.js";
import { createCanvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAcrylicPreview } from "../src/lib/image/acrylicPreview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "output", "acrylic");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const samples = [
  "Screenshot_20260227_141214_Gmail_04_extracted.png",
  "Screenshot_20260107_153725_Gmail_04_extracted.png",
  "Screenshot_20260107_154026_Gmail_04_extracted.png",
];

async function run() {
  for (const sample of samples) {
    const p = resolve(__dirname, "output", "screenshot", sample);
    const img = await napiLoadImage(p);
    const c = createCanvas(img.width, img.height);
    c.getContext("2d").drawImage(img, 0, 0);

    for (const [variantName, opts] of [
      ["with_white_ink", { showWhiteInk: true }],
      ["no_white_ink", { showWhiteInk: false }],
    ] as const) {
      // @ts-expect-error napi vs html canvas
      const preview = renderAcrylicPreview(c, opts);
      const outName = sample.replace(/_04_extracted\.png$/, `_${variantName}.png`);
      // @ts-expect-error toBuffer overload
      writeFileSync(resolve(OUT_DIR, outName), preview.toBuffer("image/png"));
      console.log(`Wrote ${outName}`);
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
