/**
 * Synthetic test fixtures + a small set of real public images.
 * Generates each fixture deterministically so test runs are reproducible.
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "fixtures");
if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });

export interface Fixture {
  name: string;
  description: string;
  path: string;
  width: number;
  height: number;
}

function saveAs(canvas: ReturnType<typeof createCanvas>, name: string): string {
  const path = resolve(FIXTURES_DIR, `${name}.png`);
  writeFileSync(path, canvas.toBuffer("image/png"));
  return path;
}

/** White background + dark logo-like shape (DTF white-removal test). */
export function generateLogoOnWhite(): Fixture {
  const W = 600;
  const H = 600;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Draw a circular badge with "DVB" text
  ctx.fillStyle = "#1f2937";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 220, 0, Math.PI * 2);
  ctx.fill();

  // Inner ring
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 200, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#dc2626";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 180, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 100px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("DVB", W / 2, H / 2);

  return {
    name: "logo-on-white",
    description: "Logo with red/dark badge on white background — chromakey white removal target",
    path: saveAs(canvas, "logo-on-white"),
    width: W,
    height: H,
  };
}

/** Black background + white-on-color logo (DTF black-removal test). */
export function generateLogoOnBlack(): Fixture {
  const W = 600;
  const H = 600;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#fbbf24";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 220, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#000000";
  ctx.font = "bold 110px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("FIRE", W / 2, H / 2);

  return {
    name: "logo-on-black",
    description: "Yellow badge with black text on solid black background",
    path: saveAs(canvas, "logo-on-black"),
    width: W,
    height: H,
  };
}

/** Green-screen subject — tests despill. */
export function generateGreenScreen(): Fixture {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // Solid green background.
  ctx.fillStyle = "#00b140";
  ctx.fillRect(0, 0, W, H);

  // Draw a "person" silhouette in red with anti-aliased edges (greenish halo).
  const grad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, 250);
  grad.addColorStop(0, "#dc2626");
  grad.addColorStop(0.85, "#dc2626");
  grad.addColorStop(0.95, "rgba(40, 80, 40, 0.6)"); // mock spill
  grad.addColorStop(1, "rgba(0, 177, 64, 0.9)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 240, 0, Math.PI * 2);
  ctx.fill();

  return {
    name: "green-screen",
    description: "Red shape on green background with a faked spill ring near the edge",
    path: saveAs(canvas, "green-screen"),
    width: W,
    height: H,
  };
}

/** PNG with semi-transparent edges (anti-aliased) — alpha threshold test. */
export function generateSoftEdges(): Fixture {
  const W = 400;
  const H = 400;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // Already-transparent canvas. Draw soft circles.
  const radial = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, 180);
  radial.addColorStop(0, "rgba(99, 102, 241, 1)");
  radial.addColorStop(0.7, "rgba(99, 102, 241, 1)");
  radial.addColorStop(1, "rgba(99, 102, 241, 0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, W, H);

  return {
    name: "soft-edges",
    description: "Indigo blob with soft (gradient-alpha) edges — should be hardened by alpha threshold",
    path: saveAs(canvas, "soft-edges"),
    width: W,
    height: H,
  };
}

/** Photo-like gradient + subject. */
export function generatePhotoLike(): Fixture {
  const W = 800;
  const H = 600;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  // Sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#3b82f6");
  sky.addColorStop(0.6, "#a5b4fc");
  sky.addColorStop(1, "#fde68a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // "Mountain"
  ctx.fillStyle = "#374151";
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(W * 0.3, H * 0.4);
  ctx.lineTo(W * 0.5, H * 0.55);
  ctx.lineTo(W * 0.75, H * 0.35);
  ctx.lineTo(W, H * 0.55);
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
  // Sun
  ctx.fillStyle = "#fef3c7";
  ctx.beginPath();
  ctx.arc(W * 0.7, H * 0.25, 60, 0, Math.PI * 2);
  ctx.fill();

  return {
    name: "photo-like",
    description: "Photo-style gradient + mountain + sun — tests photo enhancement & detection",
    path: saveAs(canvas, "photo-like"),
    width: W,
    height: H,
  };
}

/**
 * Try to download a real public image. Falls back gracefully if offline.
 */
export async function tryDownload(url: string, name: string): Promise<Fixture | null> {
  try {
    const res = await fetch(url, {
      // @ts-expect-error node fetch options
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const path = resolve(FIXTURES_DIR, `${name}.png`);
    writeFileSync(path, buf);
    // We don't know dimensions w/o decoding; tests will load it fresh anyway.
    return { name, description: `Downloaded from ${url}`, path, width: 0, height: 0 };
  } catch (err) {
    console.warn(`  ⚠  Skipped download (${name}): ${(err as Error).message}`);
    return null;
  }
}

export async function buildAllFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [
    generateLogoOnWhite(),
    generateLogoOnBlack(),
    generateGreenScreen(),
    generateSoftEdges(),
    generatePhotoLike(),
  ];
  // Optional: pull a couple of real public images (unsplash + picsum).
  const real = await Promise.all([
    tryDownload("https://picsum.photos/seed/vectorkit-portrait/800/600", "real-photo-portrait"),
    tryDownload("https://picsum.photos/seed/vectorkit-product/800/600", "real-photo-product"),
  ]);
  for (const r of real) if (r) fixtures.push(r);
  return fixtures;
}
