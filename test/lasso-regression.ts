/**
 * Visual regression for the magnetic-lasso edge map.
 *
 * Renders the edge-cost map of one of the real acrylic-invite designs
 * to disk so we can confirm by eye that strong edges (text, dress
 * silhouette, flower outlines) are correctly identified as low-cost
 * paths. Then runs a synthetic LiveWire pull from one corner to
 * another and verifies the path snakes along the dress silhouette
 * rather than cutting straight across.
 *
 *   npx tsx test/lasso-regression.ts
 *
 * Outputs:
 *   test/output/lasso/edge_map.png       — inverted edge cost
 *                                           (white = strong edge)
 *   test/output/lasso/path_overlay.png   — the source design with the
 *                                           path drawn in red
 */
import "./setup.js";
import { createCanvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeEdgeMap, LiveWire } from "../src/lib/image/lasso.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "output", "lasso");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE = resolve(
  OUT_DIR,
  "..",
  "screenshot",
  "Screenshot_20260227_141214_Gmail_04_extracted.png"
);

async function run() {
  const img = await napiLoadImage(SAMPLE);
  const c = createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  console.log(`Loaded ${img.width}x${img.height} from ${SAMPLE}`);

  // Compute edge map.
  const t0 = Date.now();
  // @ts-expect-error napi vs html canvas
  const edge = computeEdgeMap(c);
  const dtEdge = Date.now() - t0;
  console.log(`computeEdgeMap took ${dtEdge} ms`);

  // Render edge map (inverted so strong edges = white = visible).
  const edgeCanvas = createCanvas(img.width, img.height);
  const ectx = edgeCanvas.getContext("2d");
  const ed = ectx.createImageData(img.width, img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    // edge[i] is in [0.05, 1]; 0.05 = strong edge, 1 = flat.
    // Display value: 255 * (1 - normalized_cost).
    const v = Math.round(255 * (1 - (edge[i] - 0.05) / 0.95));
    ed.data[i * 4] = v;
    ed.data[i * 4 + 1] = v;
    ed.data[i * 4 + 2] = v;
    ed.data[i * 4 + 3] = 255;
  }
  ectx.putImageData(ed, 0, 0);
  // @ts-expect-error toBuffer overload
  writeFileSync(resolve(OUT_DIR, "edge_map.png"), edgeCanvas.toBuffer("image/png"));
  console.log(`Wrote edge_map.png`);

  // Trace a synthetic path: start in top-left corner, target in
  // bottom-right corner. The path SHOULD detour through dress / leaf /
  // flower edges rather than cutting diagonally across flat white area.
  const wire = new LiveWire(edge, img.width, img.height);
  const sx = Math.round(img.width * 0.1);
  const sy = Math.round(img.height * 0.45);
  const tx = Math.round(img.width * 0.9);
  const ty = Math.round(img.height * 0.55);
  wire.setSeed(sx, sy);
  const t1 = Date.now();
  const path = wire.pathTo(tx, ty);
  const dtPath = Date.now() - t1;
  console.log(
    `LiveWire pathTo(${sx},${sy})→(${tx},${ty}): ${path.length} pixels in ${dtPath} ms`
  );

  // Render path overlay on the source image.
  const overlay = createCanvas(img.width, img.height);
  const octx = overlay.getContext("2d");
  octx.drawImage(img, 0, 0);
  octx.fillStyle = "rgba(255, 0, 0, 0.85)";
  for (const [px, py] of path) {
    octx.fillRect(px - 1, py - 1, 3, 3);
  }
  // Mark seed and target.
  octx.fillStyle = "lime";
  octx.fillRect(sx - 4, sy - 4, 9, 9);
  octx.fillStyle = "yellow";
  octx.fillRect(tx - 4, ty - 4, 9, 9);
  // @ts-expect-error toBuffer overload
  writeFileSync(resolve(OUT_DIR, "path_overlay.png"), overlay.toBuffer("image/png"));
  console.log(`Wrote path_overlay.png`);

  // Sanity: the optimal path should be longer than the straight-line
  // distance (because it detours through edges) but not absurdly so.
  const straight = Math.hypot(tx - sx, ty - sy);
  console.log(
    `Straight-line distance: ${straight.toFixed(0)} px; path length: ${path.length} px (${(path.length / straight).toFixed(2)}× longer)`
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
