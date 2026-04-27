# Vectorkit

A polished, browser-based image toolkit purpose-built for DTF (Direct-to-Film) print shops and apparel designers. Remove backgrounds, harden alpha edges for crisp prints, mirror for transfer, recolor designs, resize at exact print dimensions — all without uploading a single pixel to a server.

> **Status:** v2 — full deep-audit pass with 61 automated pipeline tests on real images, alpha-thresholding throughout, and a brand-new Transform / Effects toolset.

---

## ✨ Features

### Background removal — engineered for print
- **By Color** with two strategies:
  - *Smart* (flood-fill from edges) — removes the background but keeps any matching color inside the design (e.g. white inside a flower or letter).
  - *Everywhere* (global) — removes every matching pixel.
- **AI Smart** — runs `@imgly/background-removal` ONNX entirely in your browser. Two model sizes (Fast ~80 MB, High Quality ~180 MB).
- **DTF Finishing pipeline** baked into both flows:
  - **Solid edges** — alpha threshold snaps every pixel to fully opaque or fully transparent. No halos. No partial transparency. The cutout prints with crisp ink coverage.
  - **Edge choke** — erodes the soft anti-aliased fringe by 0–5 px before thresholding to eliminate halos.
  - **Auto despill** — decontaminates green/blue/red color cast left on edge pixels after color-screen removal.

### Transform & Crop
- **Mirror H/V** — one tap to mirror your design before printing on DTF film (transfers print face-down).
- **Rotate** — 90 / 180 / 270 fast-paths plus arbitrary-angle rotation with auto-resized bounding box.
- **Auto-crop** transparent edges to tightly bound the design.
- **Standalone alpha threshold** — re-harden alpha after resize, AI removal, or any operation that re-introduces soft pixels.

### Effects & Recolor
- **Drop shadow** — soft cast shadow with offset, blur, color, and opacity (canvas grows automatically).
- **Outline / Stroke** — colored ring around the cutout via proper alpha dilation (handles thick outlines without ringing).
- **Color replace** with optional **luma preservation** — change brand colors while keeping the original shading and highlights.
- **B&W / Sepia / Invert** filters.
- **Flatten on solid color** — composite transparent designs onto a background for JPG export or social posts.

### Image enhancement
- **Photo mode**: brightness · contrast · saturation · vibrance · lift shadows · recover highlights · warmth · sharpen · auto-levels.
- **Graphic mode**: punchy contrast · vibrance · edge sharpen · alpha edge cleanup.
- One-click **Auto Enhance** preset for each mode.

### Print-ready output
- Resize in pixels, inches, or cm at any DPI (presets 150 / 300 / 600).
- Embeds proper PNG `pHYs` chunk so Photoshop, RIPs, and DTF software read the correct physical size.
- Progressive halving for downscale (preserves detail), high-quality interpolation for upscale.
- DTF-specific print presets (Shirt Front, Pocket, Sticker, Hat, Mug, A4, …).
- One-click PNG download with 300 DPI metadata.

### UX engineered for non-technical users
- **Smart Suggestion banner** — auto-detects whether your image is a photo, logo, or already-transparent design and recommends the next action.
- **Accordion side panel** — only one section open at a time, smooth expand/collapse.
- **Zoom · Pan · Eyedropper** — mouse-wheel zoom, click-drag pan, keyboard shortcuts (`+`, `-`, `0`, `1`).
- **20-step undo/redo** with a clickable breadcrumb history (jump to any past step).
- **Confirm dialogs** for destructive actions ("Start Over").
- Plain English labels everywhere (*Sensitivity* not *Tolerance*, *Smart* not *Flood Fill*).

### Privacy-first
- Everything runs in the browser. No uploads. No accounts. No tracking.

---

## 🚀 Run Locally

Requirements: Node.js 18+ (tested on Node 24).

```bash
git clone https://github.com/<your-username>/Vectorkit.git
cd Vectorkit
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Other commands

```bash
npm run build           # production build
npm run start           # serve production build
npm run lint            # eslint
npm run test:pipeline   # run 61 image-pipeline assertions on real fixtures
```

---

## 🧪 Automated pipeline tests

Vectorkit ships with a Node test harness that polyfills the browser canvas API
via `@napi-rs/canvas`, so the **actual production code** runs server-side
against a battery of synthetic + real public images.

```bash
npm run test:pipeline
```

The suite generates 5 deterministic fixtures (logo on white, logo on black,
green-screen subject, soft-alpha gradient, photo-style landscape) plus pulls 2
real Picsum photos, then runs every key algorithm (chromakey, despill, alpha
threshold, mirror, rotate, drop shadow, outline, color replace, enhance,
auto-crop, …) and reports timing, alpha distributions, and quality flags.

Outputs land in `test/output/` for visual inspection — the directory is
git-ignored so you can re-run safely.

---

## 🧠 Architecture

```
src/
├── app/                 # Next.js app router (root layout, page, globals)
│
├── components/
│   ├── Editor.tsx               # Top-level editor + landing page
│   ├── CanvasViewer.tsx         # Zoom/pan/eyedropper canvas
│   ├── BackgroundSelector.tsx   # White/black/navy/red shirt preview BG
│   ├── HistoryBreadcrumbs.tsx   # 20-step jumpable history bar
│   ├── SmartSuggestion.tsx      # Context-aware "do this next" banner
│   ├── Logo.tsx · Uploader.tsx
│   ├── panels/
│   │   ├── BgRemovalPanel.tsx   # Color + AI removal + DTF finishing
│   │   ├── TransformPanel.tsx   # Mirror, rotate, crop, alpha threshold
│   │   ├── EffectsPanel.tsx     # Shadow, outline, recolor, filters, flatten
│   │   ├── EnhancePanel.tsx     # Photo + graphic enhancement controls
│   │   └── ResizePanel.tsx      # Px/in/cm + DPI + print presets
│   └── ui/                      # Light-weight shadcn-style primitives
│
└── lib/
    ├── utils.ts                 # cn(), formatBytes(), downloadBlob()
    └── image/
        ├── canvas.ts            # loadImage, ImageData helpers, color utils
        ├── chromakey.ts         # Color-based BG removal (global + flood) + feather
        ├── aiRemoval.ts         # @imgly/background-removal wrapper
        ├── transform.ts         # Mirror, rotate, alpha threshold (with choke)
        ├── effects.ts           # Drop shadow, outline, color replace, despill, filters
        ├── enhance.ts           # Photo + graphic enhancements
        ├── resize.ts            # Resize/upscale + PNG pHYs (DPI) writer
        ├── crop.ts              # Auto-crop transparent edges
        └── detect.ts            # Photo-vs-graphic auto-detection
```

### Key implementation notes

- **Solid-edges pipeline** — chromakey produces anti-aliased alpha by design (smooth cutouts), then a separable alpha-erosion ("choke") followed by a hard threshold guarantees every output pixel is alpha 0 or 255. Critical for DTF: semi-transparent ink ruins prints; this keeps every pixel solid.
- **Despill** — for color-screen removal, edge pixels often retain a tint of the removed color. The despill pass detects the dominant spill channel and reduces it to the average of the other two.
- **Outline via alpha dilation** — separable max-filter implementation, O(W·H·R), handles thick outlines without ringing or aliasing.
- **Recolor with luma preservation** — replacing red with blue keeps shadows and highlights of the original color so the recolored region still looks 3-D.
- **PNG DPI metadata** — written by parsing the PNG header, removing any existing `pHYs` chunk, and inserting a fresh one with a CRC32. Zero native dependencies.
- **Photo-vs-graphic detection** — 5-bit color quantization across 25 000 sampled pixels plus a 32-bin luma histogram to reliably distinguish photographs from logos.

---

## 🌐 Deploy to Vercel

1. Push this repo to GitHub.
2. Import it at [vercel.com/new](https://vercel.com/new).
3. Vercel auto-detects Next.js — click **Deploy**.
4. Add your custom domain in **Settings → Domains**.

Or via CLI:

```bash
npm i -g vercel
vercel
vercel --prod
```

The `Cross-Origin-Embedder-Policy: credentialless` header set in
`next.config.ts` is needed for the WASM AI runtime — works on Vercel out of
the box.

---

## 🛣️ Roadmap

- **Batch processing** — drop a folder, process every image with the same settings, download a ZIP.
- **Gang sheet builder** — pack multiple designs onto a 22"×60" sheet with auto-rotation and gutters.
- **Underbase generator** — auto-generate the white ink under-layer for dark-fabric DTF.
- **AI upscale** — separate WASM model for true detail synthesis on low-res inputs.
- **Cloud preset sync** — save your favorite enhance/resize recipes.

---

## 📜 License

MIT — do whatever you want, just don't blame us if your DTF print smudges.
