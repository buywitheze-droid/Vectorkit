/**
 * Diagnostic: for every "*- text removed.png" in the folder, compare
 * to its original and report:
 *   • total pixels erased (alpha 0 in output that were opaque in input)
 *   • erased pixels OUTSIDE the central text zone (5%/10% margins)
 *
 * Anything with non-zero "edge erasure" indicates the script touched
 * something near the corners/flowers/splatter. Anything with very
 * high total erasure (> 15% of image area) is suspicious.
 *
 * Top N flagged files are printed for human review.
 */
import "../test/setup";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadImageFromPath, createCanvas } from "../test/setup";

const FOLDER = "B:\\Downloads\\Uv invites with transparent background";
const ALPHA_OPAQUE = 32;
const MARGIN_X = 0.05;
const MARGIN_Y = 0.10;

interface Report {
  file: string;
  totalErased: number;
  edgeErased: number;
  imgArea: number;
  edgeFrac: number;
  totalFrac: number;
}

async function main() {
  const all = fs.readdirSync(FOLDER).filter((f) => f.endsWith(" - text removed.png"));
  console.log(`Scanning ${all.length} processed files…\n`);

  const reports: Report[] = [];
  for (const out of all) {
    const orig = out.replace(" - text removed.png", ".png");
    const origPath = path.join(FOLDER, orig);
    const outPath = path.join(FOLDER, out);
    if (!fs.existsSync(origPath)) continue;
    try {
      const oImg = await loadImageFromPath(origPath);
      const cImg = await loadImageFromPath(outPath);
      if (oImg.width !== cImg.width || oImg.height !== cImg.height) continue;
      const w = oImg.width;
      const h = oImg.height;
      const oCanvas = createCanvas(w, h);
      const cCanvas = createCanvas(w, h);
      oCanvas.getContext("2d").drawImage(oImg, 0, 0);
      cCanvas.getContext("2d").drawImage(cImg, 0, 0);
      const oData = oCanvas.getContext("2d").getImageData(0, 0, w, h).data;
      const cData = cCanvas.getContext("2d").getImageData(0, 0, w, h).data;
      const xMin = w * MARGIN_X;
      const xMax = w * (1 - MARGIN_X);
      const yMin = h * MARGIN_Y;
      const yMax = h * (1 - MARGIN_Y);
      let total = 0, edge = 0;
      for (let y = 0; y < h; y++) {
        const inEdgeRow = y < yMin || y >= yMax;
        for (let x = 0; x < w; x++) {
          const k = (y * w + x) * 4 + 3;
          if (oData[k] >= ALPHA_OPAQUE && cData[k] < ALPHA_OPAQUE) {
            total++;
            if (inEdgeRow || x < xMin || x >= xMax) edge++;
          }
        }
      }
      const area = w * h;
      reports.push({
        file: out,
        totalErased: total,
        edgeErased: edge,
        imgArea: area,
        edgeFrac: edge / area,
        totalFrac: total / area,
      });
      process.stdout.write(".");
    } catch (e) {
      process.stdout.write("x");
    }
  }
  console.log("\n");

  // Sort by edge erasure (worst at top).
  reports.sort((a, b) => b.edgeFrac - a.edgeFrac);
  console.log("=== TOP 15 by EDGE erasure (corners/flowers/splatter damage) ===");
  console.log("edge%  total%  edge_px    total_px   file");
  for (const r of reports.slice(0, 15)) {
    console.log(
      `${(r.edgeFrac * 100).toFixed(2).padStart(5)}  ` +
        `${(r.totalFrac * 100).toFixed(2).padStart(5)}  ` +
        `${r.edgeErased.toString().padStart(8)}  ` +
        `${r.totalErased.toString().padStart(9)}  ` +
        r.file
    );
  }
  console.log("\n=== TOP 10 by TOTAL erasure (might over-erase even in zone) ===");
  reports.sort((a, b) => b.totalFrac - a.totalFrac);
  console.log("edge%  total%  edge_px    total_px   file");
  for (const r of reports.slice(0, 10)) {
    console.log(
      `${(r.edgeFrac * 100).toFixed(2).padStart(5)}  ` +
        `${(r.totalFrac * 100).toFixed(2).padStart(5)}  ` +
        `${r.edgeErased.toString().padStart(8)}  ` +
        `${r.totalErased.toString().padStart(9)}  ` +
        r.file
    );
  }
  console.log("\nTotal files: " + reports.length);
  const withEdge = reports.filter((r) => r.edgeErased > 0).length;
  console.log(`Files with ANY edge-zone erasure: ${withEdge} / ${reports.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
