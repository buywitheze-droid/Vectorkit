/**
 * End-to-end test of every key image-processing function in the app
 * against a battery of fixture images.
 *
 *   npx tsx test/run-pipeline.ts
 *
 * Outputs go to `test/output/` so you can visually compare before/after.
 */
import "./setup.js"; // browser-canvas polyfills FIRST
import { Image as NapiImage, type Canvas, loadImage as napiLoadImage } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAllFixtures, type Fixture } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { chromakey } from "../src/lib/image/chromakey.js";
import {
  applyAlphaThreshold,
  alphaStats,
  mirrorHorizontal,
  mirrorVertical,
  rotateDegrees,
} from "../src/lib/image/transform.js";
import {
  despill,
  dropShadow,
  outline,
  replaceColor,
  grayscale,
  flattenBackground,
} from "../src/lib/image/effects.js";
import { enhancePhoto, enhanceGraphic } from "../src/lib/image/enhance.js";
import { autoCropTransparent } from "../src/lib/image/crop.js";
import { detectImageType } from "../src/lib/image/detect.js";

const OUTPUT_DIR = resolve(__dirname, "output");
if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

interface TestResult {
  fixture: string;
  step: string;
  ok: boolean;
  ms: number;
  notes: string[];
  outPath?: string;
}
const results: TestResult[] = [];

function saveCanvas(canvas: Canvas | HTMLCanvasElement, name: string): string {
  const path = resolve(OUTPUT_DIR, `${name}.png`);
  // @ts-expect-error napi canvas has toBuffer method
  writeFileSync(path, canvas.toBuffer("image/png"));
  return path;
}

async function loadFixtureImage(fixture: Fixture): Promise<HTMLImageElement> {
  const img = await napiLoadImage(fixture.path);
  return img as unknown as HTMLImageElement;
}

async function loadCanvasFromFixture(fixture: Fixture): Promise<HTMLCanvasElement> {
  const img = await napiLoadImage(fixture.path);
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("ctx");
  ctx.drawImage(img as unknown as HTMLImageElement, 0, 0);
  return canvas;
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

function record(
  fixture: Fixture,
  step: string,
  ok: boolean,
  ms: number,
  notes: string[],
  outPath?: string
) {
  results.push({ fixture: fixture.name, step, ok, ms, notes, outPath });
  const tag = ok ? "PASS" : "FAIL";
  console.log(
    `   [${tag}] ${step.padEnd(28)} ${String(ms).padStart(5)}ms` +
      (notes.length ? `  ${notes.join(" · ")}` : "")
  );
}

async function runFixture(fixture: Fixture) {
  console.log(`\n━━━ ${fixture.name} ━━━`);
  console.log(`    ${fixture.description}`);

  let canvas: HTMLCanvasElement;
  try {
    canvas = await loadCanvasFromFixture(fixture);
  } catch (e) {
    console.log(`   [SKIP] could not load (${(e as Error).message})`);
    return;
  }

  // 1. Detection
  try {
    const { ms, value: det } = await timed(() => detectImageType(canvas));
    record(fixture, "detect", true, ms, [
      `type=${det.type}`,
      `recommend=${det.recommendedAction}`,
      `transparent=${det.hasTransparency}`,
      `colors=${det.uniqueColors}`,
    ]);
  } catch (e) {
    record(fixture, "detect", false, 0, [(e as Error).message]);
  }

  // 2. Color background removal (white) — only meaningful for white-bg fixtures
  if (fixture.name === "logo-on-white" || fixture.name === "soft-edges") {
    try {
      const img = await loadFixtureImage(fixture);
      const { ms, value: out } = await timed(() =>
        chromakey(img, {
          color: "#ffffff",
          tolerance: 8,
          strategy: "flood",
          edgeFeather: 1,
        })
      );
      const stats = alphaStats(out);
      const path = saveCanvas(out, `${fixture.name}_chromakey-white`);
      record(fixture, "chromakey-white", true, ms, [
        `transparent=${stats.fullyTransparent}`,
        `opaque=${stats.fullyOpaque}`,
        `semi=${stats.semiTransparent} (${stats.semiTransparentPct.toFixed(1)}%)`,
      ], path);
    } catch (e) {
      record(fixture, "chromakey-white", false, 0, [(e as Error).message]);
    }
  }

  // 3. Color background removal (black)
  if (fixture.name === "logo-on-black") {
    try {
      const img = await loadFixtureImage(fixture);
      const { ms, value: out } = await timed(() =>
        chromakey(img, {
          color: "#000000",
          tolerance: 8,
          strategy: "flood",
          edgeFeather: 1,
        })
      );
      const stats = alphaStats(out);
      const path = saveCanvas(out, `${fixture.name}_chromakey-black`);
      record(fixture, "chromakey-black", true, ms, [
        `transparent=${stats.fullyTransparent}`,
        `opaque=${stats.fullyOpaque}`,
        `semi=${stats.semiTransparent} (${stats.semiTransparentPct.toFixed(1)}%)`,
      ], path);
    } catch (e) {
      record(fixture, "chromakey-black", false, 0, [(e as Error).message]);
    }
  }

  // 4. Green screen + despill + alpha threshold (the FULL DTF flow)
  if (fixture.name === "green-screen") {
    try {
      const img = await loadFixtureImage(fixture);
      const removed = await chromakey(img, {
        color: "#00b140",
        tolerance: 25,
        strategy: "flood",
        edgeFeather: 1,
      });
      const beforeStats = alphaStats(removed);

      const { ms: t1, value: despilled } = await timed(() =>
        despill(removed, "#00b140")
      );
      const { ms: t2, value: hardened } = await timed(() =>
        applyAlphaThreshold(despilled, { threshold: 128, choke: 1 })
      );
      const afterStats = alphaStats(hardened);
      const path = saveCanvas(hardened, `${fixture.name}_full-dtf`);
      record(fixture, "green-screen-full-dtf", true, t1 + t2, [
        `before: opaque=${beforeStats.fullyOpaque} semi=${beforeStats.semiTransparent} (${beforeStats.semiTransparentPct.toFixed(1)}%)`,
        `after: opaque=${afterStats.fullyOpaque} semi=${afterStats.semiTransparent} (${afterStats.semiTransparentPct.toFixed(1)}%)`,
        afterStats.semiTransparent === 0 ? "✓ ALL PIXELS SOLID" : `⚠ ${afterStats.semiTransparent} semi-transparent`,
      ], path);
    } catch (e) {
      record(fixture, "green-screen-full-dtf", false, 0, [(e as Error).message]);
    }
  }

  // 5. Alpha threshold on already-soft alpha
  if (fixture.name === "soft-edges") {
    try {
      const beforeStats = alphaStats(canvas);
      const { ms, value: out } = await timed(() =>
        applyAlphaThreshold(canvas, { threshold: 128, choke: 0 })
      );
      const afterStats = alphaStats(out);
      const path = saveCanvas(out, `${fixture.name}_alpha-threshold`);
      record(fixture, "alpha-threshold", true, ms, [
        `before semi=${beforeStats.semiTransparent} (${beforeStats.semiTransparentPct.toFixed(1)}%)`,
        `after semi=${afterStats.semiTransparent} (${afterStats.semiTransparentPct.toFixed(1)}%)`,
        afterStats.semiTransparent === 0 ? "✓ ALL PIXELS SOLID" : `⚠ ${afterStats.semiTransparent} semi-transparent`,
      ], path);
    } catch (e) {
      record(fixture, "alpha-threshold", false, 0, [(e as Error).message]);
    }
  }

  // 6. Mirror H + V
  try {
    const { ms: t1, value: mh } = await timed(() => mirrorHorizontal(canvas));
    const { ms: t2, value: mv } = await timed(() => mirrorVertical(canvas));
    saveCanvas(mh, `${fixture.name}_mirror-h`);
    saveCanvas(mv, `${fixture.name}_mirror-v`);
    record(fixture, "mirror-h+v", true, t1 + t2, [
      `${mh.width}x${mh.height} (h)`,
      `${mv.width}x${mv.height} (v)`,
    ]);
  } catch (e) {
    record(fixture, "mirror-h+v", false, 0, [(e as Error).message]);
  }

  // 7. Rotate 90 + 45
  try {
    const { ms: t1, value: r90 } = await timed(() => rotateDegrees(canvas, 90));
    const { ms: t2, value: r45 } = await timed(() => rotateDegrees(canvas, 45));
    saveCanvas(r90, `${fixture.name}_rotate-90`);
    saveCanvas(r45, `${fixture.name}_rotate-45`);
    record(fixture, "rotate 90+45", true, t1 + t2, [
      `90° → ${r90.width}x${r90.height}`,
      `45° → ${r45.width}x${r45.height}`,
    ]);
  } catch (e) {
    record(fixture, "rotate 90+45", false, 0, [(e as Error).message]);
  }

  // 8. Drop shadow + outline (need transparency — do these on hardened green screen)
  if (fixture.name === "green-screen" || fixture.name === "soft-edges") {
    try {
      // Get a transparent version first
      let transparent: HTMLCanvasElement;
      if (fixture.name === "green-screen") {
        const img = await loadFixtureImage(fixture);
        const removed = await chromakey(img, {
          color: "#00b140",
          tolerance: 25,
          strategy: "flood",
          edgeFeather: 1,
        });
        transparent = applyAlphaThreshold(despill(removed, "#00b140"), {
          threshold: 128,
          choke: 1,
        });
      } else {
        transparent = canvas;
      }

      const { ms: t1, value: shadowed } = await timed(() =>
        dropShadow(transparent, {
          offsetX: 8,
          offsetY: 8,
          blur: 12,
          color: "#000000",
          opacity: 0.5,
        })
      );
      saveCanvas(shadowed, `${fixture.name}_dropshadow`);
      record(fixture, "drop-shadow", true, t1, [
        `${shadowed.width}x${shadowed.height} (canvas grew)`,
      ]);

      const { ms: t2, value: outlined } = await timed(() =>
        outline(transparent, { width: 6, color: "#ffffff" })
      );
      saveCanvas(outlined, `${fixture.name}_outline`);
      record(fixture, "outline", true, t2, [
        `${outlined.width}x${outlined.height}`,
      ]);
    } catch (e) {
      record(fixture, "drop-shadow+outline", false, 0, [(e as Error).message]);
    }
  }

  // 9. Color replacement
  try {
    const { ms, value: replaced } = await timed(() =>
      replaceColor(canvas, {
        fromColor: "#dc2626",
        toColor: "#0066ff",
        tolerance: 30,
        preserveLuma: true,
      })
    );
    saveCanvas(replaced, `${fixture.name}_recolor`);
    record(fixture, "color-replace", true, ms, ["red→blue with luma preserved"]);
  } catch (e) {
    record(fixture, "color-replace", false, 0, [(e as Error).message]);
  }

  // 10. Grayscale
  try {
    const { ms, value: gray } = await timed(() => grayscale(canvas));
    saveCanvas(gray, `${fixture.name}_grayscale`);
    record(fixture, "grayscale", true, ms, []);
  } catch (e) {
    record(fixture, "grayscale", false, 0, [(e as Error).message]);
  }

  // 11. Photo enhancement (auto-levels, brightness, etc.)
  try {
    const { ms, value: enhanced } = await timed(() =>
      enhancePhoto(canvas, {
        brightness: 5,
        contrast: 15,
        saturation: 15,
        vibrance: 20,
        shadows: 10,
        highlights: -5,
        warmth: 0,
        sharpen: 30,
        autoLevels: true,
      })
    );
    saveCanvas(enhanced, `${fixture.name}_enhance-photo`);
    record(fixture, "enhance-photo", true, ms, []);
  } catch (e) {
    record(fixture, "enhance-photo", false, 0, [(e as Error).message]);
  }

  // 12. Graphic enhancement
  try {
    const { ms, value: enhanced } = await timed(() =>
      enhanceGraphic(canvas, {
        contrast: 15,
        vibrance: 20,
        sharpen: 30,
        edgeCleanup: 30,
      })
    );
    saveCanvas(enhanced, `${fixture.name}_enhance-graphic`);
    record(fixture, "enhance-graphic", true, ms, []);
  } catch (e) {
    record(fixture, "enhance-graphic", false, 0, [(e as Error).message]);
  }

  // 13. Auto-crop after BG removal
  if (fixture.name === "logo-on-white" || fixture.name === "soft-edges") {
    try {
      const img = await loadFixtureImage(fixture);
      const removed = await chromakey(img, {
        color: fixture.name === "logo-on-white" ? "#ffffff" : "#000000",
        tolerance: 8,
        strategy: "flood",
        edgeFeather: 1,
      });
      const { ms, value: cropped } = await timed(() => autoCropTransparent(removed));
      saveCanvas(cropped, `${fixture.name}_autocrop`);
      record(fixture, "auto-crop", true, ms, [
        `${removed.width}x${removed.height} → ${cropped.width}x${cropped.height}`,
      ]);
    } catch (e) {
      record(fixture, "auto-crop", false, 0, [(e as Error).message]);
    }
  }

  // 14. Flatten BG
  if (fixture.name === "soft-edges") {
    try {
      const { ms, value: flat } = await timed(() => flattenBackground(canvas, "#fef3c7"));
      saveCanvas(flat, `${fixture.name}_flatten`);
      record(fixture, "flatten-bg", true, ms, []);
    } catch (e) {
      record(fixture, "flatten-bg", false, 0, [(e as Error).message]);
    }
  }
}

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║  TheVectorKit · Image Pipeline Test Suite                  ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  console.log("\n► Building fixtures…");
  const fixtures = await buildAllFixtures();
  console.log(`   ${fixtures.length} fixtures ready in test/fixtures/`);

  for (const fx of fixtures) {
    await runFixture(fx);
  }

  // Summary
  console.log("\n────────────────────────────────────────────────────────────");
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  const totalTime = results.reduce((s, r) => s + r.ms, 0);
  console.log(
    `Done: ${passed.length} passed · ${failed.length} failed · ${totalTime}ms total`
  );
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`   ✗ ${f.fixture} → ${f.step}: ${f.notes.join(" · ")}`);
  }

  // Quality flags: any "semi-transparent" pixels found post-finish?
  const dtfQuality = results.filter(
    (r) => r.notes.some((n) => n.includes("semi-transparent"))
  );
  if (dtfQuality.length > 0) {
    console.log("\nDTF-quality flags:");
    for (const r of dtfQuality)
      console.log(`   ⚠ ${r.fixture}/${r.step}: ${r.notes.find((n) => n.includes("semi"))}`);
  }

  console.log(`\nOutputs: ${OUTPUT_DIR}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
