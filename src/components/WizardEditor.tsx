"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  Lasso,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Type as TypeIcon,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Logo, Wordmark } from "@/components/Logo";
import { Uploader } from "@/components/Uploader";
import { CanvasViewer, type BackgroundMode } from "@/components/CanvasViewer";
import { BackgroundSelector } from "@/components/BackgroundSelector";
import { MaskCanvas } from "@/components/MaskCanvas";
import { TextLayerOverlay } from "@/components/TextLayerOverlay";
import { TextLayerInspector } from "@/components/TextLayerInspector";
import { Button } from "@/components/ui/Button";

import {
  hexToRgb,
  imageToCanvas,
  loadImage,
  rgbToHex,
} from "@/lib/image/canvas";
import { DEFAULT_FONT_ID, getFont } from "@/lib/fonts/registry";
import {
  newTextLayerId,
  type TextLayer,
  type TextLayerPatch,
} from "@/lib/image/textLayer";
import { renderTextLayers } from "@/lib/image/textRender";
import {
  decontaminateEdges,
  eraseRegion,
  removeEnclosedHoles,
  smartErase,
} from "@/lib/image/chromakey";
import { restoreColor } from "@/lib/image/restore";
import { removeBackgroundAi } from "@/lib/image/aiRemoval";
import { canvasToBlob, setPngDpi } from "@/lib/image/resize";
import {
  detectSourceType,
  extractFromScreenshot,
} from "@/lib/image/screenshot";
import { renderAcrylicPreview } from "@/lib/image/acrylicPreview";
import {
  COMMON_PRINT_SIZES,
  effectiveSourceDpi,
  pixelDimsFor,
  renderForPrint,
  type PrintSize,
} from "@/lib/image/printRender";
import { downloadBlob, formatBytes, cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────

type Step = "upload" | "remove" | "repair" | "download";

const STEPS: { id: Step; title: string; subtitle: string }[] = [
  { id: "upload", title: "Upload", subtitle: "Pick your design" },
  { id: "remove", title: "Clean", subtitle: "Remove background" },
  { id: "repair", title: "Touch up", subtitle: "Fix any missing parts" },
  { id: "download", title: "Done", subtitle: "Save your image" },
];

interface WizardEditorProps {
  onSwitchToAdvanced: () => void;
}

type RemovalMethod = "smart" | "ai";

interface RemovalOption {
  status: "idle" | "running" | "ready" | "error";
  canvas: HTMLCanvasElement | null;
  error?: string;
  /** AI-only progress 0-100. */
  progressPct?: number;
  progressLabel?: string;
  /** Smart-erase only: the detected background color (hex). */
  detectedBg?: string;
}

const DEFAULT_OPTION: RemovalOption = { status: "idle", canvas: null };

export function WizardEditor({ onSwitchToAdvanced }: WizardEditorProps) {
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  // The unmodified upload — used as the colour source for restore-touchups
  // in Step 3 (when we need to bring back a sampled colour from the source).
  const [originalCanvas, setOriginalCanvas] = useState<HTMLCanvasElement | null>(null);
  const [currentCanvas, setCurrentCanvas] = useState<HTMLCanvasElement | null>(null);
  // Pre-BG-removal source for text vectorisation. The trick:
  //   • For graphics: traceCanvas = the upload (pre-chromakey, pre-touchup).
  //     Tracing from this captures FULL letter shapes that smart-erase
  //     would have eaten anti-alias edges of.
  //   • For screenshots: traceCanvas = the auto-extracted canvas BEFORE any
  //     manual touch-ups. Phone chrome is already cropped (so we don't
  //     trace Gmail headers as "text") but design text is still pristine.
  // Set once on upload and never mutated. The cutout's opacity at
  // composite time still gates where the vector text appears, so anything
  // the user manually erased stays erased — see composeVectorOverlays().
  const [traceCanvas, setTraceCanvas] = useState<HTMLCanvasElement | null>(null);
  const [chosenMethod, setChosenMethod] = useState<RemovalMethod | null>(null);
  const [smartOpt, setSmartOpt] = useState<RemovalOption>(DEFAULT_OPTION);
  const [aiOpt, setAiOpt] = useState<RemovalOption>(DEFAULT_OPTION);
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewBg, setPreviewBg] = useState<BackgroundMode>("transparent");
  const [restoredCount, setRestoredCount] = useState(0);
  const [touchupMode, setTouchupMode] = useState<"restore" | "erase">("restore");
  // Source-type detection result. "screenshot" means we'll auto-route
  // through extractFromScreenshot before showing Step 2; "graphic" routes
  // through the existing Smart-Erase / AI cutout pair.
  const [sourceType, setSourceType] = useState<"screenshot" | "graphic" | null>(null);
  // True while the manual masking surface (MaskCanvas) is open as a
  // fullscreen overlay. The wizard's Step 3 stays mounted underneath.
  const [maskOverlayOpen, setMaskOverlayOpen] = useState(false);
  // Acrylic-preview options on Step 4 — toggle the white-ink underlayer.
  const [showWhiteInk, setShowWhiteInk] = useState(true);
  // Print-output options on Step 4. The source canvas is upscaled to
  // these dimensions on download. "Source size" (the default) leaves the
  // image at its native pixel dimensions and only re-stamps the DPI tag.
  const [printSize, setPrintSize] = useState<PrintSize>(
    () => COMMON_PRINT_SIZES[1] // 5×7" — most common acrylic-invite size
  );
  const [printDpi, setPrintDpi] = useState<number>(300);
  // Vectorise solid-coloured text into smooth Bezier paths before
  // rasterising at the target resolution. The visible-quality win on
  // upscale-heavy prints (>1.5× source). Off when "Source size" is
  // selected (no upscale = no text-pixelation problem to fix).
  const [vectorizeText, setVectorizeText] = useState<boolean>(true);
  const [sharpenOutput, setSharpenOutput] = useState<boolean>(true);
  const [renderProgress, setRenderProgress] = useState<{
    stage: string;
    pct: number;
  } | null>(null);
  // Tracks whether the user has applied the global "remove all remaining
  // [BG color]" pass. We disable the button after one click — clicking
  // again would be a no-op (no more BG-colored pixels exist), and showing
  // the button as repeatable confuses the user.
  const [globallyCleared, setGloballyCleared] = useState(false);

  // ─── Text overlay layers ────────────────────────────────────────────────
  // Lives at the wizard level (not per-step) so layers survive
  // navigation between Step 3 (where you add/edit them) and Step 4
  // (where they show in the acrylic preview and get baked into the
  // downloaded PNG). Coordinates are in source-canvas pixels — see
  // src/lib/image/textLayer.ts for the model.
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  // ─── Step 1: Upload ─────────────────────────────────────────────────────
  //
  // On upload we auto-detect the source type:
  //
  //   • "screenshot" — phone screenshot of a transparent PNG viewed in a
  //     gallery / email / browser. The transparency is faked with the
  //     gallery's checkerboard preview and there's phone OS / app chrome
  //     baked in around the design. Auto-extracted via the screenshot
  //     pipeline (crop chrome → replace checker with alpha=0). The user
  //     lands directly on Step 3 (touch-up) since extraction is
  //     deterministic and rarely needs the chromakey/AI fallback.
  //   • "graphic" — a regular design with a real solid-colour background
  //     (white, black, etc.). Routed through the existing Smart-Erase /
  //     AI cutout pair on Step 2 so the user can pick the cleaner result.
  //
  // The detection is cheap (<50 ms) — runs synchronously on the main
  // thread before transitioning out of the upload screen.
  const handleFile = useCallback(async (uploaded: File) => {
    try {
      const img = await loadImage(uploaded);
      const canvas = imageToCanvas(img);
      setFile(uploaded);
      setOriginalCanvas(canvas);
      setRestoredCount(0);
      setChosenMethod(null);
      setSmartOpt(DEFAULT_OPTION);
      setAiOpt(DEFAULT_OPTION);

      const detected = detectSourceType(canvas);
      setSourceType(detected);

      if (detected === "screenshot") {
        // Run the screenshot extractor inline. If anything goes wrong we
        // fall back to the chromakey / AI pipeline so the user is never
        // stuck.
        try {
          const result = extractFromScreenshot(canvas);
          setCurrentCanvas(result.canvas);
          // For text vectorisation: trace from the freshly-extracted
          // canvas. It has clean text (the extractor doesn't damage
          // pixels) AND no phone chrome (so we won't accidentally
          // vectorise the Gmail header).
          setTraceCanvas(result.canvas);
          setStep("repair");
          toast.success("Auto-extracted from screenshot", {
            description: `Cropped phone chrome · removed checker pattern · ${result.canvas.width}\u00a0\u00d7\u00a0${result.canvas.height} px`,
          });
          return;
        } catch (e) {
          console.warn("Screenshot extraction failed, falling back:", e);
          toast.info("Couldn't auto-extract — try the manual options");
        }
      }

      // Graphic path (or screenshot fallback): show Step 2 result picker.
      setCurrentCanvas(canvas);
      // Trace from the pristine upload — pre-chromakey text is sharpest.
      setTraceCanvas(canvas);
      setStep("remove");
      toast.success("Loaded", {
        description: `${img.naturalWidth} \u00d7 ${img.naturalHeight} px \u00b7 ${formatBytes(uploaded.size)}`,
      });
    } catch {
      toast.error("Couldn't load that image. Try another file.");
    }
  }, []);

  // ─── Step 2: Run BOTH algorithms in parallel; user picks winner ─────────
  //
  // No single algorithm is right for every image:
  //   • "Smart Erase" = edge-flood chromakey. Finds the dominant background
  //     color from corners, then removes only edge-connected matching pixels.
  //     Interior pixels (white inside letters / flowers / crowns) are always
  //     preserved. Best for invitations, logos, product shots on a clean BG.
  //   • "AI Cutout" = imgly ISNet model. Recognizes humans / objects as the
  //     foreground regardless of color. Best for photographs.
  //
  // We run both in parallel so the user can compare and pick — no guessing.

  const runSmartErase = useCallback(async (manualBgColor?: string) => {
    if (!originalCanvas) return;
    setSmartOpt({ status: "running", canvas: null });
    try {
      // Yield so the UI paints the spinner before CPU-heavy work.
      await new Promise((r) => setTimeout(r, 16));

      // Auto-detect the background color (whole-image modal). If the user
      // overrode it via "Click background to fix," trust their pick and
      // treat the BG as clean (noise 0).
      const auto = analyzeBackground(originalCanvas);
      const bgColor = manualBgColor ?? auto.color;
      const noise = manualBgColor ? 0 : auto.noise;

      // ─── Why these numbers (verified by test/smart-erase-regression.ts) ──
      //
      // The previous implementation used maxFringeSteps=3 + edgeFeather=1.
      // Regression test on a synthetic invitation (white BG, pink dress,
      // white-centered flower, gold crown w/ white highlights, white-
      // filled letters) showed it ate ~1100 anti-alias pixels of the
      // design AND leaked 4 pixels of "real" pink/gold — visibly chopping
      // the dress/flower edges.
      //
      // The new config:
      //   • tightTolerance / fringeTolerance kept conservative — pure-BG
      //     pixels propagate freely, near-BG pixels propagate one step.
      //   • maxFringeSteps = 1: only ONE anti-alias pixel layer is eaten
      //     by the flood (vs 3 before). This is the difference between
      //     "preserve the dress" and "shave 3 pixels off it."
      //   • edgeFeather = 0: alpha box-blur smeared the edge both ways
      //     and visually merged design with the cut zone. Replaced with
      //     a real edge decontamination pass below.
      //
      // Test result for this config: 99.73% of design preserved, 0 deep
      // leaks (vs 99.33% / 4 leaks for the old config).
      const tightTolerance = Math.max(3, Math.min(6, Math.round(noise + 2)));
      const fringeTolerance = tightTolerance + 3;

      const img = new Image();
      img.src = originalCanvas.toDataURL();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode failed"));
      });

      // Step 1 — depth-limited flood: removes BG and one layer of fringe.
      let result = await smartErase(img, {
        bgColor,
        tightTolerance,
        fringeTolerance,
        maxFringeSteps: 1,
        edgeFeather: 0,
      });

      // Step 2 — edge decontamination: each surviving fringe pixel is
      // either snapped to its inferred design color (clean crisp edge,
      // no white halo around dress / letter / flower) or dropped to
      // transparent if it's mostly BG bleed. This is the "Photoshop
      // layer-mask + matte refine" trick we built earlier; without it
      // the flood leaves a 1px dingy halo that the user reads as "the
      // background isn't fully gone."
      result = decontaminateEdges(result, {
        bgColor,
        dropThreshold: 0.4,
        iterations: 1,
        innerSearchRadius: 3,
      });

      setSmartOpt({ status: "ready", canvas: result, detectedBg: bgColor });
    } catch (e) {
      console.error(e);
      setSmartOpt({
        status: "error",
        canvas: null,
        error: e instanceof Error ? e.message : "Failed",
      });
    }
  }, [originalCanvas]);

  const runAiCutout = useCallback(async () => {
    if (!originalCanvas) return;
    setAiOpt({
      status: "running",
      canvas: null,
      progressPct: 0,
      progressLabel: "Preparing…",
    });
    try {
      const sourceBlob = await canvasToBlob(originalCanvas, "image/png");
      const resultBlob = await removeBackgroundAi(sourceBlob, {
        quality: "high",
        onProgress: (key, current, total) => {
          const pct = total > 0 ? (current / total) * 100 : 0;
          let label = "Working…";
          if (key.includes("download") || key.includes("fetch")) {
            label = "Loading model…";
          } else if (key.includes("compute") || key.includes("inference")) {
            label = "Analyzing…";
          } else if (key.includes("decode") || key.includes("encode")) {
            label = "Finalizing…";
          }
          setAiOpt((prev) => ({
            ...prev,
            status: "running",
            progressPct: pct,
            progressLabel: label,
          }));
        },
      });

      const img = await loadImage(resultBlob);
      const result = imageToCanvas(img);
      setAiOpt({ status: "ready", canvas: result });
    } catch (e) {
      console.error(e);
      setAiOpt({
        status: "error",
        canvas: null,
        error: e instanceof Error ? e.message : "Failed",
      });
    }
  }, [originalCanvas]);

  // Kick off both methods automatically when the user enters Step 2.
  useEffect(() => {
    if (step !== "remove" || !originalCanvas) return;
    if (smartOpt.status === "idle") void runSmartErase();
    if (aiOpt.status === "idle") void runAiCutout();
  }, [step, originalCanvas, smartOpt.status, aiOpt.status, runSmartErase, runAiCutout]);

  const handlePickResult = useCallback(
    (method: RemovalMethod) => {
      const opt = method === "smart" ? smartOpt : aiOpt;
      if (opt.status !== "ready" || !opt.canvas) return;
      setChosenMethod(method);
      setCurrentCanvas(opt.canvas);
      setRestoredCount(0);
      setGloballyCleared(false);
      setStep("repair");
    },
    [smartOpt, aiOpt]
  );

  const handleRetryMethod = useCallback(
    (method: RemovalMethod) => {
      if (method === "smart") {
        setSmartOpt(DEFAULT_OPTION);
        void runSmartErase();
      } else {
        setAiOpt(DEFAULT_OPTION);
        void runAiCutout();
      }
    },
    [runSmartErase, runAiCutout]
  );

  const handleManualBgPick = useCallback(
    (hex: string) => {
      setSmartOpt(DEFAULT_OPTION);
      void runSmartErase(hex);
      toast.info(`Background set to ${hex.toUpperCase()} — re-running Smart Erase…`);
    },
    [runSmartErase]
  );

  // ─── Step 3: Tap-to-restore OR tap-to-erase ─────────────────────────────

  const handleTap = useCallback(
    (hex: string, x: number, y: number) => {
      if (!currentCanvas) return;
      if (touchupMode === "restore") {
        if (!originalCanvas) return;
        // Smart mode: highly saturated, mid-luma colors are likely text/logos
        // → restore as solid for crisp uniform fill. Pastels → restore as
        // original to preserve shading/gradients.
        const mode = pickRestoreMode(hex);
        try {
          const { canvas, pixelsRestored } = restoreColor(
            currentCanvas,
            originalCanvas,
            {
              color: hex,
              tolerance: mode === "solid" ? 26 : 22,
              padding: 1,
              searchRadius: 50,
              mode,
            }
          );
          if (pixelsRestored === 0) {
            toast.info("Nothing to bring back there", {
              description:
                "That color isn't missing nearby. Try tapping a spot that's clearly cut off.",
            });
            return;
          }
          setCurrentCanvas(canvas);
          setRestoredCount((c) => c + 1);
          toast.success(
            `Brought back ${pixelsRestored.toLocaleString()} pixel${pixelsRestored === 1 ? "" : "s"}`
          );
        } catch (e) {
          console.error(e);
          toast.error("Restore failed");
        }
      } else {
        // Erase mode: flood-fill remove the tapped color from this point.
        // Tight tolerance (was 12 — too aggressive, ate adjacent design via
        // anti-alias chains). 6 ≈ ±27 RGB which catches the connected
        // patch + its 1-px halo without burrowing into bordering design.
        try {
          const { canvas, pixelsErased } = eraseRegion(currentCanvas, x, y, {
            tolerance: 6,
            fringeFeather: 0,
          });
          if (pixelsErased === 0) {
            toast.info("Nothing to erase there", {
              description: "That spot is already transparent.",
            });
            return;
          }
          setCurrentCanvas(canvas);
          setRestoredCount((c) => c + 1);
          toast.success(
            `Erased ${pixelsErased.toLocaleString()} pixel${pixelsErased === 1 ? "" : "s"}`
          );
        } catch (e) {
          console.error(e);
          toast.error("Erase failed");
        }
      }
    },
    [currentCanvas, originalCanvas, touchupMode]
  );

  const handleUndoRepair = useCallback(() => {
    // Reset to the post-removal canvas (the one the user picked in Step 2).
    if (restoredCount === 0) return;
    const opt = chosenMethod === "ai" ? aiOpt : smartOpt;
    if (opt.canvas) {
      setCurrentCanvas(opt.canvas);
      setRestoredCount(0);
      setGloballyCleared(false);
    }
  }, [restoredCount, chosenMethod, smartOpt, aiOpt]);

  // ─── Quick action: remove BG color stuck inside thin-walled holes ───────
  //
  // The previous version used a global chromakey ("remove every remaining
  // BG-colored pixel") and ate dress highlights and flower interiors as
  // collateral. The user wants something more precise: ONLY clean the
  // enclosed BG inside letters, between fingers, in tight gaps — the
  // places where the surrounding shape is THIN (a letter stroke, a
  // hairline). Anything deep inside thick design elements (dress flesh,
  // flower petals, crown body) stays.
  //
  // The regression test (test/smart-erase-regression.ts) verifies that
  // letter holes get removed while flower whites and dress highlights
  // are preserved on a synthetic invitation.
  const handleRemoveAllOfBgColor = useCallback(() => {
    if (!currentCanvas) return;
    const bgColor = smartOpt.detectedBg ?? "#ffffff";
    try {
      const { canvas, pixelsRemoved, blobsRemoved, blobsKept } =
        removeEnclosedHoles(currentCanvas, {
          color: bgColor,
          tolerance: 3,
          maxSurroundingThickness: 14,
          decontaminate: true,
        });
      if (pixelsRemoved === 0) {
        toast.info("Nothing to clean inside letters", {
          description:
            blobsKept > 0
              ? `Found ${blobsKept} enclosed area${blobsKept === 1 ? "" : "s"} but they're surrounded by thick design — left them alone. Use Remove mode below to delete one by hand.`
              : `No enclosed ${bgColor.toUpperCase()} pixels left in the image.`,
        });
        setGloballyCleared(true);
        return;
      }
      setCurrentCanvas(canvas);
      setRestoredCount((c) => c + 1);
      setGloballyCleared(true);
      toast.success(
        `Cleaned ${blobsRemoved} letter / hole interior${blobsRemoved === 1 ? "" : "s"} (${pixelsRemoved.toLocaleString()} px)`,
        {
          description:
            blobsKept > 0
              ? `${blobsKept} thicker-walled area${blobsKept === 1 ? "" : "s"} kept (likely flower / dress / face). Use Remove mode if any need to go.`
              : "Use Reset touch-ups if anything was removed by mistake.",
        }
      );
    } catch (e) {
      console.error(e);
      toast.error("Could not remove letter interiors");
    }
  }, [currentCanvas, smartOpt.detectedBg]);

  // ─── Step 4: Download ───────────────────────────────────────────────────

  const handleDownload = useCallback(async () => {
    if (!currentCanvas || !file) return;
    setIsProcessing(true);
    setRenderProgress({ stage: "Starting", pct: 0 });
    try {
      const dims = pixelDimsFor(currentCanvas, printSize, printDpi);
      // Skip the heavy print-render pipeline entirely when no resize is
      // requested — it would just be Lanczos at 1× (no-op) + maybe text
      // vectorise (also pointless at 1×). Direct PNG export is faster
      // and bit-for-bit preserves the user's manual touch-ups.
      const noResize =
        dims.width === currentCanvas.width &&
        dims.height === currentCanvas.height;

      let outCanvas = currentCanvas;
      let vectorisedCount = 0;
      if (!noResize) {
        const result = await renderForPrint(currentCanvas, {
          targetWidth: dims.width,
          targetHeight: dims.height,
          vectorizeText,
          sharpen: sharpenOutput,
          // Trace from the pristine pre-BG-removal source so vectorised
          // text captures the original letter shapes — not the
          // possibly-eroded edges in the cutout.
          traceSource: traceCanvas ?? undefined,
          onProgress: (stage, pct) => setRenderProgress({ stage, pct }),
        });
        outCanvas = result.canvas;
        vectorisedCount = result.vectorizedColours.length;
      }

      // Bake user-added text layers onto the final canvas. We do this
      // AFTER printRender so the layers render at the target resolution
      // (vector-quality glyphs from the actual font file, NOT a scaled-up
      // raster of preview text). Position/size scale automatically from
      // source-canvas coords to target via renderTextLayers.
      if (textLayers.length > 0) {
        setRenderProgress({ stage: "Adding text", pct: 95 });
        await renderTextLayers(textLayers, {
          target: outCanvas,
          sourceWidth: currentCanvas.width,
          sourceHeight: currentCanvas.height,
        });
      }

      let blob = await canvasToBlob(outCanvas, "image/png");
      blob = await setPngDpi(blob, printDpi);
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const sizeTag =
        printSize.widthIn > 0
          ? `${printSize.widthIn}x${printSize.heightIn}`
          : "source";
      downloadBlob(blob, `${baseName} - vectorkit ${sizeTag}.png`);
      const detailParts = [`${outCanvas.width} \u00d7 ${outCanvas.height} px @ ${printDpi} DPI`];
      if (vectorisedCount > 0) {
        detailParts.push(`${vectorisedCount} text colour${vectorisedCount === 1 ? "" : "s"} vectorised`);
      }
      if (textLayers.length > 0) {
        detailParts.push(`${textLayers.length} text layer${textLayers.length === 1 ? "" : "s"} added`);
      }
      toast.success("Downloaded", {
        description: detailParts.join(" \u00b7 "),
      });
    } catch (e) {
      console.error(e);
      toast.error("Download failed");
    } finally {
      setIsProcessing(false);
      setRenderProgress(null);
    }
  }, [currentCanvas, file, printSize, printDpi, vectorizeText, sharpenOutput, traceCanvas, textLayers]);

  // ─── Navigation ─────────────────────────────────────────────────────────

  const handleStartOver = useCallback(() => {
    setStep("upload");
    setFile(null);
    setOriginalCanvas(null);
    setCurrentCanvas(null);
    setTraceCanvas(null);
    setRestoredCount(0);
    setChosenMethod(null);
    setSmartOpt(DEFAULT_OPTION);
    setAiOpt(DEFAULT_OPTION);
    setSourceType(null);
    setMaskOverlayOpen(false);
    setTextLayers([]);
    setSelectedTextId(null);
  }, []);

  const handleBack = useCallback(() => {
    if (step === "remove") {
      handleStartOver();
    } else if (step === "repair") {
      // Screenshots skipped Step 2 — going back from Step 3 returns
      // to Upload. Graphics rewind to the Step 2 picker.
      if (sourceType === "screenshot") {
        handleStartOver();
      } else {
        setStep("remove");
        setRestoredCount(0);
      }
    } else if (step === "download") {
      setStep("repair");
    }
  }, [step, sourceType, handleStartOver]);

  // ─── Manual masking overlay (magnetic lasso + click-to-grow + brush) ────
  //
  // Triggered from Step 3 by the "Mask manually" button. Opens MaskCanvas
  // as a fullscreen overlay over the wizard. On Apply, the resulting
  // canvas replaces currentCanvas and the overlay closes.
  const handleOpenMask = useCallback(() => {
    if (!currentCanvas) return;
    setMaskOverlayOpen(true);
  }, [currentCanvas]);

  const handleMaskCommit = useCallback((masked: HTMLCanvasElement) => {
    setCurrentCanvas(masked);
    setMaskOverlayOpen(false);
    setRestoredCount((c) => c + 1);
    toast.success("Mask applied");
  }, []);

  const handleMaskCancel = useCallback(() => {
    setMaskOverlayOpen(false);
  }, []);

  // ─── Text layer handlers ────────────────────────────────────────────────
  //
  // Add: places a new layer at a click position (or canvas centre when
  //   no position is provided). Auto-selects so the inspector pops up
  //   immediately and the user can start typing.
  // Patch: dispatched per-field by the inspector.
  // Move: drag handler from the overlay; deltas are in source pixels.
  // Delete: removes the layer + clears selection if it was selected.
  const handleAddText = useCallback(
    (sx?: number, sy?: number) => {
      if (!currentCanvas) return;
      const font = getFont(DEFAULT_FONT_ID);
      if (!font) return;
      const x = sx ?? currentCanvas.width / 2;
      const y = sy ?? currentCanvas.height / 2;
      // Default size: tied to the font's intended role (script/display/body)
      // so the first thing the user sees on a fresh layer reads naturally.
      const size = font.defaultSizeFactor * currentCanvas.height;
      const layer: TextLayer = {
        id: newTextLayerId(),
        text: "Your text here",
        fontId: font.id,
        weight: font.weights[0] ?? 400,
        italic: false,
        size,
        color: "#b8956a",
        align: "center",
        x,
        y,
        rotation: 0,
        letterSpacing: 0,
      };
      setTextLayers((prev) => [...prev, layer]);
      setSelectedTextId(layer.id);
    },
    [currentCanvas]
  );

  const handlePatchText = useCallback(
    (id: string, patch: TextLayerPatch) => {
      setTextLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, ...patch } : l))
      );
    },
    []
  );

  const handleMoveText = useCallback(
    (id: string, dx: number, dy: number) => {
      setTextLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, x: l.x + dx, y: l.y + dy } : l))
      );
    },
    []
  );

  const handleDeleteText = useCallback((id: string) => {
    setTextLayers((prev) => prev.filter((l) => l.id !== id));
    setSelectedTextId((prev) => (prev === id ? null : prev));
  }, []);

  const selectedTextLayer = useMemo(
    () => textLayers.find((l) => l.id === selectedTextId) ?? null,
    [textLayers, selectedTextId]
  );

  const goToDownload = useCallback(() => setStep("download"), []);

  // Default to transparent (checkerboard) preview — leaves no doubt that
  // the background is gone. User can switch to navy/white via the
  // background toggle to inspect against a contrasting color.
  useEffect(() => {
    if (step === "repair") setPreviewBg("transparent");
    else if (step === "download") setPreviewBg("transparent");
  }, [step]);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header
        stepIndex={stepIndex}
        onStartOver={handleStartOver}
        onSwitchToAdvanced={onSwitchToAdvanced}
        canStartOver={step !== "upload"}
      />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 md:py-10">
          {step === "upload" && <StepUpload onFile={handleFile} />}
          {step === "remove" && originalCanvas && (
            <StepRemove
              originalCanvas={originalCanvas}
              smartOpt={smartOpt}
              aiOpt={aiOpt}
              onPick={handlePickResult}
              onRetry={handleRetryMethod}
              onManualBgPick={handleManualBgPick}
              onBack={handleBack}
              onUseAdvanced={onSwitchToAdvanced}
            />
          )}
          {step === "repair" && currentCanvas && (
            <StepRepair
              canvas={currentCanvas}
              sourceType={sourceType}
              previewBg={previewBg}
              setPreviewBg={setPreviewBg}
              restoredCount={restoredCount}
              touchupMode={touchupMode}
              setTouchupMode={setTouchupMode}
              onTap={handleTap}
              onContinue={goToDownload}
              onUndo={handleUndoRepair}
              onBack={handleBack}
              bgColor={smartOpt.detectedBg ?? "#ffffff"}
              onRemoveAllOfBgColor={handleRemoveAllOfBgColor}
              globallyCleared={globallyCleared}
              onOpenMask={handleOpenMask}
              textLayers={textLayers}
              selectedTextId={selectedTextId}
              selectedTextLayer={selectedTextLayer}
              onSelectText={setSelectedTextId}
              onAddText={handleAddText}
              onMoveText={handleMoveText}
              onPatchText={handlePatchText}
              onDeleteText={handleDeleteText}
            />
          )}
          {step === "download" && currentCanvas && (
            <StepDownload
              canvas={currentCanvas}
              previewBg={previewBg}
              setPreviewBg={setPreviewBg}
              isProcessing={isProcessing}
              onDownload={handleDownload}
              onBack={handleBack}
              onStartOver={handleStartOver}
              onUseAdvanced={onSwitchToAdvanced}
              showWhiteInk={showWhiteInk}
              setShowWhiteInk={setShowWhiteInk}
              printSize={printSize}
              setPrintSize={setPrintSize}
              printDpi={printDpi}
              setPrintDpi={setPrintDpi}
              vectorizeText={vectorizeText}
              setVectorizeText={setVectorizeText}
              sharpenOutput={sharpenOutput}
              setSharpenOutput={setSharpenOutput}
              renderProgress={renderProgress}
              textLayers={textLayers}
            />
          )}
        </div>
      </main>

      {/* Fullscreen manual-masking overlay. Mounted on top of the wizard
       *  whenever the user clicks "Mask manually" in Step 3. Backdrops
       *  the rest of the page so the toolbar + viewport occupy the entire
       *  screen — gives the user the precision of a pro masking tool
       *  without losing the wizard underneath.
       */}
      {maskOverlayOpen && currentCanvas && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col">
          <MaskCanvas
            source={currentCanvas}
            onCommit={handleMaskCommit}
            onCancel={handleMaskCancel}
          />
        </div>
      )}
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function Header({
  stepIndex,
  onStartOver,
  onSwitchToAdvanced,
  canStartOver,
}: {
  stepIndex: number;
  onStartOver: () => void;
  onSwitchToAdvanced: () => void;
  canStartOver: boolean;
}) {
  return (
    <header className="border-b border-border bg-card/80 backdrop-blur-sm shrink-0">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <Wordmark className="text-base" />
        </div>
        <ol className="hidden md:flex items-center gap-1 text-xs">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1 transition-colors",
                  i === stepIndex
                    ? "bg-primary text-primary-foreground font-medium"
                    : i < stepIndex
                      ? "bg-success/15 text-success"
                      : "text-muted-foreground"
                )}
              >
                {i < stepIndex ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <span className="font-mono">{i + 1}</span>
                )}
                <span>{s.title}</span>
              </div>
              {i < STEPS.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
              )}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2">
          {canStartOver && (
            <Button variant="ghost" size="sm" onClick={onStartOver}>
              <RefreshCw className="h-3.5 w-3.5" />
              Start over
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onSwitchToAdvanced}
            title="Switch to Advanced Editor with all power tools"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Advanced
          </Button>
        </div>
      </div>
      {/* Mobile step indicator */}
      <div className="md:hidden border-t border-border px-4 py-1.5 text-xs text-muted-foreground text-center">
        Step {stepIndex + 1} of {STEPS.length} —{" "}
        <span className="font-medium text-foreground">
          {STEPS[stepIndex].title}
        </span>
      </div>
    </header>
  );
}

// ─── Step 1: Upload ────────────────────────────────────────────────────────

function StepUpload({ onFile }: { onFile: (f: File) => void }) {
  return (
    <div className="text-center py-6 md:py-12">
      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-primary/10 px-3 py-1 rounded-full mb-5">
        <Sparkles className="h-3.5 w-3.5" />
        Free · No signup · Stays in your browser
      </div>
      <h1 className="text-3xl md:text-5xl font-bold tracking-tight mb-3">
        Acrylic invites, <span className="brand-gradient-text">print-ready</span> in seconds
      </h1>
      <p className="text-base md:text-lg text-muted-foreground max-w-xl mx-auto mb-8">
        Drop in a phone screenshot of your design or the original PNG. We auto-detect what kind of file it is, strip the background or phone chrome, and let you fine-tune the silhouette by hand.
      </p>
      <Uploader onFile={onFile} />
      <p className="mt-6 text-xs text-muted-foreground">
        Works with: phone screenshots of invites · PNGs / JPGs from email or cloud · designs with solid backgrounds
      </p>
    </div>
  );
}

// ─── Step 2: Remove ────────────────────────────────────────────────────────

function StepRemove({
  originalCanvas,
  smartOpt,
  aiOpt,
  onPick,
  onRetry,
  onManualBgPick,
  onBack,
  onUseAdvanced,
}: {
  originalCanvas: HTMLCanvasElement;
  smartOpt: RemovalOption;
  aiOpt: RemovalOption;
  onPick: (m: RemovalMethod) => void;
  onRetry: (m: RemovalMethod) => void;
  onManualBgPick: (hex: string) => void;
  onBack: () => void;
  onUseAdvanced: () => void;
}) {
  const [pickingBg, setPickingBg] = useState(false);
  const bothFailed = smartOpt.status === "error" && aiOpt.status === "error";

  return (
    <div>
      <StepHeader
        number={2}
        title="Pick the cleaner cutout"
        subtitle="We tried two ways to remove the background. Tap whichever one looks right — the other will be discarded. Refine by hand in the next step if needed."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ResultTile
          label="Smart Erase"
          hint="Best for invitations, logos, designs on a clean background"
          opt={smartOpt}
          onPick={() => onPick("smart")}
          onRetry={() => onRetry("smart")}
        />
        <ResultTile
          label="AI Cutout"
          hint="Best for photos of people, products, animals"
          opt={aiOpt}
          onPick={() => onPick("ai")}
          onRetry={() => onRetry("ai")}
          showAiNote
        />
      </div>

      {smartOpt.status === "ready" && smartOpt.detectedBg && (
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>Smart Erase detected the background as</span>
          <span
            className="inline-block w-4 h-4 rounded border border-border align-middle"
            style={{ backgroundColor: smartOpt.detectedBg }}
            aria-label={`detected background ${smartOpt.detectedBg}`}
          />
          <span className="font-mono">{smartOpt.detectedBg.toUpperCase()}</span>
          <span>·</span>
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => setPickingBg((v) => !v)}
          >
            {pickingBg ? "Cancel" : "Wrong color? Click to fix"}
          </button>
        </div>
      )}

      {bothFailed && (
        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive mb-1">
            Both methods failed
          </p>
          <p className="text-muted-foreground mb-3">
            Try the Advanced Editor for manual color-pick removal with full
            control.
          </p>
          <Button onClick={onUseAdvanced} variant="primary">
            Open Advanced Editor
          </Button>
        </div>
      )}

      {pickingBg ? (
        <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="text-sm font-medium mb-2 text-center">
            Click anywhere on the background of the original image below
          </div>
          <CanvasFrame
            canvas={originalCanvas}
            previewBg="white"
            setPreviewBg={() => {}}
            hideBgPicker
            pickMode
            onPick={(hex) => {
              setPickingBg(false);
              onManualBgPick(hex);
            }}
            helperText="Cursor is in pick mode — click on a background pixel"
          />
        </div>
      ) : (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground select-none">
            See the original
          </summary>
          <div className="mt-2 max-w-md">
            <CanvasFrame
              canvas={originalCanvas}
              previewBg="white"
              setPreviewBg={() => {}}
              hideBgPicker
              compact
            />
          </div>
        </details>
      )}

      <ActionBar
        primary={null}
        secondary={
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        }
      />
    </div>
  );
}

function ResultTile({
  label,
  hint,
  opt,
  onPick,
  onRetry,
  showAiNote,
}: {
  label: string;
  hint: string;
  opt: RemovalOption;
  onPick: () => void;
  onRetry: () => void;
  showAiNote?: boolean;
}) {
  const isReady = opt.status === "ready" && opt.canvas;
  return (
    <div
      className={cn(
        "group relative rounded-xl border bg-card overflow-hidden transition-all",
        isReady
          ? "border-border hover:border-primary hover:shadow-lg cursor-pointer"
          : "border-border"
      )}
      onClick={isReady ? onPick : undefined}
      role={isReady ? "button" : undefined}
      tabIndex={isReady ? 0 : undefined}
      onKeyDown={(e) => {
        if (isReady && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">
            {label}
            {opt.status === "ready" && (
              <Check className="h-4 w-4 text-emerald-500" />
            )}
          </div>
          <div className="text-[11px] text-muted-foreground">{hint}</div>
        </div>
        {opt.status === "ready" && (
          <span className="text-[11px] font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
            Tap to use →
          </span>
        )}
      </div>

      <div className="aspect-square checker-bg flex items-center justify-center relative">
        {opt.canvas ? (
          <CanvasThumb canvas={opt.canvas} />
        ) : opt.status === "running" ? (
          <div className="text-center px-4">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
            <div className="text-xs text-muted-foreground">
              {opt.progressLabel ?? "Working…"}
            </div>
            {typeof opt.progressPct === "number" && opt.progressPct > 0 && (
              <div className="mt-2 mx-auto w-32 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full brand-gradient transition-all"
                  style={{ width: `${opt.progressPct}%` }}
                />
              </div>
            )}
            {showAiNote && (
              <p className="mt-3 text-[10px] text-muted-foreground/70 max-w-[18rem] mx-auto leading-snug">
                First time only: AI model downloads (~180&nbsp;MB). Future
                runs are ~5&nbsp;seconds.
              </p>
            )}
          </div>
        ) : opt.status === "error" ? (
          <div className="text-center px-4">
            <p className="text-xs text-destructive mb-2">
              {opt.error ?? "Failed"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              <RefreshCw className="h-3 w-3" /> Retry
            </Button>
          </div>
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

/** Renders a canvas as a downscaled <img> via toDataURL. Cheap and crisp. */
function CanvasThumb({ canvas }: { canvas: HTMLCanvasElement }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    setSrc(canvas.toDataURL("image/png"));
  }, [canvas]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt="cutout preview"
      className="max-w-full max-h-full object-contain"
      draggable={false}
    />
  );
}

// ─── Step 3: Repair ────────────────────────────────────────────────────────

function StepRepair({
  canvas,
  sourceType,
  previewBg,
  setPreviewBg,
  restoredCount,
  touchupMode,
  setTouchupMode,
  onTap,
  onContinue,
  onUndo,
  onBack,
  bgColor,
  onRemoveAllOfBgColor,
  globallyCleared,
  onOpenMask,
  textLayers,
  selectedTextId,
  selectedTextLayer,
  onSelectText,
  onAddText,
  onMoveText,
  onPatchText,
  onDeleteText,
}: {
  canvas: HTMLCanvasElement;
  sourceType: "screenshot" | "graphic" | null;
  previewBg: BackgroundMode;
  setPreviewBg: (bg: BackgroundMode) => void;
  restoredCount: number;
  touchupMode: "restore" | "erase";
  setTouchupMode: (m: "restore" | "erase") => void;
  onTap: (hex: string, x: number, y: number) => void;
  onContinue: () => void;
  onUndo: () => void;
  onBack: () => void;
  bgColor: string;
  onRemoveAllOfBgColor: () => void;
  globallyCleared: boolean;
  onOpenMask: () => void;
  textLayers: TextLayer[];
  selectedTextId: string | null;
  selectedTextLayer: TextLayer | null;
  onSelectText: (id: string | null) => void;
  onAddText: (sx?: number, sy?: number) => void;
  onMoveText: (id: string, dx: number, dy: number) => void;
  onPatchText: (id: string, patch: TextLayerPatch) => void;
  onDeleteText: (id: string) => void;
}) {
  const isErase = touchupMode === "erase";
  const colorName = bgColorName(bgColor);
  const isScreenshot = sourceType === "screenshot";
  const hasTextLayers = textLayers.length > 0;
  return (
    <div>
      <StepHeader
        number={3}
        title={isScreenshot ? "Refine the cutout" : "Anything missing or stuck?"}
        subtitle={
          isScreenshot
            ? "Auto-extracted from your screenshot. Fine-tune the silhouette by hand or use the magnetic lasso to trace the design's outline."
            : "Optional: one click removes any leftover background hiding inside letters. Or open the manual masking tools to trace the design exactly."
        }
      />

      {/* ─── Headline actions: manual masking + text tools ──────────────── */}
      <div className="mb-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border-2 border-primary/40 bg-gradient-to-br from-primary/10 to-primary/5 p-4 flex items-start gap-3">
          <div className="h-10 w-10 rounded-md bg-primary/15 shrink-0 flex items-center justify-center text-primary">
            <Lasso className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold mb-0.5">Mask manually for total control</div>
            <div className="text-xs text-muted-foreground mb-2.5">
              Trace around the design with the magnetic lasso (snaps to edges as you tap), or click inside each element to keep it.
            </div>
            <Button variant="primary" size="sm" onClick={onOpenMask}>
              <Lasso className="h-4 w-4" /> Open masking tools
            </Button>
          </div>
        </div>
        <div className="rounded-xl border-2 border-accent/40 bg-gradient-to-br from-accent/10 to-accent/5 p-4 flex items-start gap-3">
          <div className="h-10 w-10 rounded-md bg-accent/15 shrink-0 flex items-center justify-center text-accent">
            <TypeIcon className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold mb-0.5">
              Add or replace text
              {hasTextLayers && (
                <span className="ml-2 inline-flex items-center justify-center px-1.5 h-4 min-w-[1rem] rounded-full bg-accent text-accent-foreground text-[10px] font-mono">
                  {textLayers.length}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground mb-2.5">
              {hasTextLayers
                ? "Drag layers to reposition · click to select · use the inspector below to edit. Layers print at full resolution."
                : "Personalise designs with the curated invitation font library. Pick from script, display caps, and body styles."}
            </div>
            <Button variant="accent" size="sm" onClick={() => onAddText()}>
              <Plus className="h-4 w-4" /> Add text layer
            </Button>
          </div>
        </div>
      </div>

      {/* ─── Quick action: clean BG color inside letters / thin-walled holes ─
       *   Only shown for the "graphic" path — screenshots have already been
       *   cleanly extracted and don't have a residual BG colour to mop up. */}
      {!isScreenshot && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4 flex items-center gap-3 flex-wrap">
          <div
            className="h-9 w-9 rounded-md border border-border shrink-0"
            style={{ backgroundColor: bgColor }}
            title={bgColor.toUpperCase()}
          />
          <div className="flex-1 min-w-[14rem]">
            <div className="text-sm font-semibold">
              Clean {colorName} inside letters &amp; small holes
            </div>
            <div className="text-xs text-muted-foreground">
              Targets {colorName} stuck inside thin-walled shapes (letter
              interiors, gaps between fingers). Leaves flower centers, dress
              highlights, and other thick design areas untouched.
            </div>
          </div>
          <Button
            variant={globallyCleared ? "outline" : "primary"}
            onClick={onRemoveAllOfBgColor}
            disabled={globallyCleared}
            className="shrink-0"
          >
            {globallyCleared ? (
              <>
                <Check className="h-4 w-4" /> Done
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" /> Clean inside letters
              </>
            )}
          </Button>
        </div>
      )}

      <div className="mb-2 text-xs text-muted-foreground text-center">
        Or fine-tune by hand:
      </div>

      <div className="mb-3 flex items-center gap-2 p-1 rounded-lg border border-border bg-card w-fit mx-auto">
        <button
          type="button"
          onClick={() => setTouchupMode("restore")}
          className={cn(
            "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
            !isErase
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="text-base leading-none">＋</span>
          Bring back
        </button>
        <button
          type="button"
          onClick={() => setTouchupMode("erase")}
          className={cn(
            "px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2",
            isErase
              ? "bg-destructive text-destructive-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="text-base leading-none">－</span>
          Remove
        </button>
      </div>

      <div
        className={cn(
          "rounded-lg border p-3 mb-3 text-sm flex items-start gap-2",
          isErase
            ? "border-destructive/30 bg-destructive/5"
            : "border-primary/30 bg-primary/5"
        )}
      >
        <span className="text-lg leading-none">👆</span>
        <div>
          {isErase ? (
            <>
              <strong>Click on a leftover shape you want gone</strong> — like a
              white speech bubble, a stray patch, or any unwanted color region
              still in the design. Only that connected blob will be removed.
            </>
          ) : (
            <>
              <strong>Click on any spot in your design</strong> where a color
              is still visible — and we&apos;ll bring back the missing pieces
              of that same color from the original.
            </>
          )}
        </div>
      </div>

      <div className={cn(
        "grid gap-4",
        selectedTextLayer ? "grid-cols-1 lg:grid-cols-[1fr_320px]" : "grid-cols-1"
      )}>
        <div>
          <CanvasFrame
            canvas={canvas}
            previewBg={previewBg}
            setPreviewBg={setPreviewBg}
            pickMode
            onPick={onTap}
            helperText={
              selectedTextLayer
                ? "Drag the dashed text to move \u00b7 click empty space to deselect"
                : isErase
                  ? "Cursor is in erase mode \u2014 click a leftover shape to delete it"
                  : "Cursor is in restore mode \u2014 click any color you want to bring back"
            }
            overlay={
              hasTextLayers ? (
                <TextLayerOverlay
                  layers={textLayers}
                  selectedId={selectedTextId}
                  interactive
                  scale={1}
                  onSelect={onSelectText}
                  onMove={onMoveText}
                />
              ) : null
            }
          />

          <div className="mt-3 text-center text-xs text-muted-foreground">
            {restoredCount === 0
              ? "Tip: switch the preview to navy or white to spot leftovers more easily."
              : `${restoredCount} touch-up${restoredCount === 1 ? "" : "s"} applied \u2014 keep going or click \u201cLooks good\u201d when done.`}
          </div>
        </div>

        {selectedTextLayer && (
          <aside className="rounded-xl border border-border bg-card p-4 self-start lg:sticky lg:top-4">
            <TextLayerInspector
              layer={selectedTextLayer}
              sourceHeight={canvas.height}
              onPatch={(patch) => onPatchText(selectedTextLayer.id, patch)}
              onDelete={() => onDeleteText(selectedTextLayer.id)}
            />
          </aside>
        )}
      </div>

      <ActionBar
        primary={
          <Button
            variant="gradient"
            size="lg"
            onClick={onContinue}
            className="px-8"
          >
            Looks good — continue
            <ChevronRight className="h-4 w-4" />
          </Button>
        }
        secondary={
          <>
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            {restoredCount > 0 && (
              <Button variant="ghost" onClick={onUndo}>
                <RefreshCw className="h-4 w-4" /> Reset touch-ups
              </Button>
            )}
            <Button variant="ghost" onClick={onContinue}>
              Skip
            </Button>
          </>
        }
      />
    </div>
  );
}

// ─── Step 4: Download ──────────────────────────────────────────────────────

function StepDownload({
  canvas,
  previewBg,
  setPreviewBg,
  isProcessing,
  onDownload,
  onBack,
  onStartOver,
  onUseAdvanced,
  showWhiteInk,
  setShowWhiteInk,
  printSize,
  setPrintSize,
  printDpi,
  setPrintDpi,
  vectorizeText,
  setVectorizeText,
  sharpenOutput,
  setSharpenOutput,
  renderProgress,
  textLayers,
}: {
  canvas: HTMLCanvasElement;
  previewBg: BackgroundMode;
  setPreviewBg: (bg: BackgroundMode) => void;
  isProcessing: boolean;
  onDownload: () => void;
  onBack: () => void;
  onStartOver: () => void;
  onUseAdvanced: () => void;
  showWhiteInk: boolean;
  setShowWhiteInk: (v: boolean) => void;
  printSize: PrintSize;
  setPrintSize: (s: PrintSize) => void;
  printDpi: number;
  setPrintDpi: (d: number) => void;
  vectorizeText: boolean;
  setVectorizeText: (v: boolean) => void;
  sharpenOutput: boolean;
  setSharpenOutput: (v: boolean) => void;
  renderProgress: { stage: string; pct: number } | null;
  textLayers: TextLayer[];
}) {
  const targetDims = pixelDimsFor(canvas, printSize, printDpi);
  const effectiveDpi = effectiveSourceDpi(canvas, printSize);
  const isUpscale = targetDims.width > canvas.width;
  const isDownscale = targetDims.width < canvas.width;
  const upscaleRatio = targetDims.width / canvas.width;
  const dpiQuality: "great" | "ok" | "low" =
    effectiveDpi === null
      ? "great"
      : effectiveDpi >= 250
        ? "great"
        : effectiveDpi >= 150
          ? "ok"
          : "low";

  return (
    <div>
      <StepHeader
        number={4}
        title="Pick the print size and download"
        subtitle="Your design is ready. Choose the acrylic size you&apos;re printing at — we&apos;ll resize, sharpen text, and stamp the right DPI for your printer."
      />

      {/* ─── Print-size + quality controls ─────────────────────────────────── */}
      <div className="mb-4 rounded-xl border border-border bg-card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Acrylic size
            </label>
            <select
              value={printSize.label}
              onChange={(e) => {
                const next = COMMON_PRINT_SIZES.find((s) => s.label === e.target.value);
                if (next) setPrintSize(next);
              }}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            >
              {COMMON_PRINT_SIZES.map((s) => (
                <option key={s.label} value={s.label}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Print resolution (DPI)
            </label>
            <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
              {[150, 300, 600].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setPrintDpi(d)}
                  className={cn(
                    "flex-1 py-1.5 text-xs font-medium rounded transition-colors",
                    printDpi === d
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Quality readout */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <span className="text-muted-foreground">
            Output: <span className="font-mono text-foreground">{targetDims.width} × {targetDims.height} px</span>
          </span>
          {effectiveDpi !== null && (
            <span className="text-muted-foreground">
              Source DPI at this size:{" "}
              <span
                className={cn(
                  "font-mono font-medium",
                  dpiQuality === "great" && "text-emerald-600",
                  dpiQuality === "ok" && "text-amber-600",
                  dpiQuality === "low" && "text-destructive"
                )}
              >
                ~{Math.round(effectiveDpi)}
              </span>
            </span>
          )}
          {isUpscale && (
            <span className="text-muted-foreground">
              Upscale: <span className="font-mono text-foreground">{upscaleRatio.toFixed(2)}×</span>
            </span>
          )}
          {isDownscale && (
            <span className="text-muted-foreground">
              Downscale: <span className="font-mono text-foreground">{(1 / upscaleRatio).toFixed(2)}×</span>
            </span>
          )}
        </div>

        {/* Quality hint */}
        {dpiQuality === "low" && (
          <div className="mt-2 text-[11px] text-destructive">
            Your source resolution is low for this print size. Text vectorisation (below) will keep letters sharp; soft decorative elements may still show some softness.
          </div>
        )}
        {dpiQuality === "ok" && (
          <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
            Source DPI is on the borderline. Keep text vectorisation on for crisp letters.
          </div>
        )}

        {/* Toggles */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs border-t border-border pt-3">
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={vectorizeText}
              onChange={(e) => setVectorizeText(e.target.checked)}
              className="accent-primary"
              disabled={!isUpscale}
            />
            <span className={!isUpscale ? "text-muted-foreground" : "text-foreground font-medium"}>
              Vectorise text
            </span>
            <span className="text-muted-foreground">
              {isUpscale
                ? "(traces solid-colour letters into smooth curves — razor-sharp)"
                : "(only useful when upscaling)"}
            </span>
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={sharpenOutput}
              onChange={(e) => setSharpenOutput(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-foreground font-medium">Edge sharpen</span>
            <span className="text-muted-foreground">(boosts contrast at edges only)</span>
          </label>
        </div>
      </div>

      {/* ─── Cutout + acrylic preview side-by-side ─────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2 px-1">
            Cutout preview {textLayers.length > 0 && `(with ${textLayers.length} text layer${textLayers.length === 1 ? "" : "s"})`}
          </div>
          <CanvasFrame
            canvas={canvas}
            previewBg={previewBg}
            setPreviewBg={setPreviewBg}
            overlay={
              textLayers.length > 0 ? (
                <TextLayerOverlay
                  layers={textLayers}
                  selectedId={null}
                  interactive={false}
                  scale={1}
                />
              ) : null
            }
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2 px-1 gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              Acrylic preview
            </div>
            <label className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showWhiteInk}
                onChange={(e) => setShowWhiteInk(e.target.checked)}
                className="accent-primary"
              />
              White ink underlayer
            </label>
          </div>
          <AcrylicPreviewFrame
            canvas={canvas}
            showWhiteInk={showWhiteInk}
            textLayers={textLayers}
          />
          <div className="mt-2 px-1 text-[11px] text-muted-foreground leading-snug">
            White-ink underlayer simulates the printer&apos;s opaque white pass. Toggle off to preview <em>without</em> white ink — light-coloured elements will look washed out.
          </div>
        </div>
      </div>

      <ActionBar
        primary={
          <Button
            variant="gradient"
            size="lg"
            onClick={onDownload}
            disabled={isProcessing}
            className="px-8"
          >
            {isProcessing ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Download className="h-5 w-5" />
            )}
            {isProcessing && renderProgress
              ? `${renderProgress.stage}… ${Math.round(renderProgress.pct)}%`
              : "Download PNG"}
          </Button>
        }
        secondary={
          <>
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button variant="ghost" onClick={onStartOver}>
              <RefreshCw className="h-4 w-4" /> New image
            </Button>
            <Button variant="outline" onClick={onUseAdvanced}>
              <Settings2 className="h-4 w-4" /> Resize, mirror, effects…
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Re-renders the acrylic preview whenever the source canvas, white-ink
 *  toggle, or text layers change. Heavy lifting (~5–15 ms for the
 *  acrylic compositor + ~5–30 ms for text rendering) happens in an
 *  effect so we don't block the main thread while React reconciles.
 *
 *  Text layers are baked into the cutout BEFORE the acrylic compositor
 *  runs — that way the white-ink underlayer (if enabled) covers the
 *  text the same way it covers the rest of the design, giving an
 *  accurate "this is what the print will look like on clear acrylic"
 *  preview. */
function AcrylicPreviewFrame({
  canvas,
  showWhiteInk,
  textLayers,
}: {
  canvas: HTMLCanvasElement;
  showWhiteInk: boolean;
  textLayers: TextLayer[];
}) {
  const [previewSrc, setPreviewSrc] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        let source = canvas;
        if (textLayers.length > 0) {
          // Composite cutout + text layers onto a fresh canvas at source
          // resolution. Skip mutating the original (it'd dirty the
          // touch-up history if the user ever goes back to Step 3).
          const composite = document.createElement("canvas");
          composite.width = canvas.width;
          composite.height = canvas.height;
          const cctx = composite.getContext("2d");
          if (cctx) {
            cctx.drawImage(canvas, 0, 0);
            await renderTextLayers(textLayers, {
              target: composite,
              sourceWidth: canvas.width,
              sourceHeight: canvas.height,
            });
            source = composite;
          }
        }
        const preview = renderAcrylicPreview(source, {
          showWhiteInk,
          outputWidth: 720,
        });
        if (!cancelled) setPreviewSrc(preview.toDataURL("image/png"));
      } catch (e) {
        console.error("Acrylic preview failed:", e);
      }
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [canvas, showWhiteInk, textLayers]);
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="bg-[#f4ead8] flex items-center justify-center min-h-[400px] p-2">
        {previewSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewSrc}
            alt="acrylic preview"
            className="max-w-full max-h-[55vh] object-contain"
            draggable={false}
          />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

// ─── Shared layout pieces ──────────────────────────────────────────────────

function StepHeader({
  number,
  title,
  subtitle,
}: {
  number: number;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-4 md:mb-6">
      <div className="text-xs font-mono text-primary mb-1">
        Step {number} of {STEPS.length}
      </div>
      <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-1">
        {title}
      </h2>
      <p className="text-sm md:text-base text-muted-foreground max-w-2xl">
        {subtitle}
      </p>
    </div>
  );
}

function CanvasFrame({
  canvas,
  previewBg,
  setPreviewBg,
  pickMode,
  onPick,
  helperText,
  hideBgPicker,
  compact,
  overlay,
  onCanvasClick,
}: {
  canvas: HTMLCanvasElement;
  previewBg: BackgroundMode;
  setPreviewBg: (bg: BackgroundMode) => void;
  pickMode?: boolean;
  onPick?: (hex: string, x: number, y: number) => void;
  helperText?: string;
  hideBgPicker?: boolean;
  compact?: boolean;
  /** Mounted into CanvasViewer's overlay slot so it sits in
   *  source-canvas coords on top of the design. Used for text layers. */
  overlay?: React.ReactNode;
  onCanvasClick?: (sx: number, sy: number) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
        <div className="text-[11px] text-muted-foreground font-mono">
          {canvas.width} × {canvas.height} px
        </div>
        {!hideBgPicker && (
          <BackgroundSelector value={previewBg} onChange={setPreviewBg} />
        )}
      </div>
      <div
        className={cn(
          "relative",
          compact ? "h-[35vh] min-h-[240px]" : "h-[55vh] min-h-[400px]"
        )}
      >
        <CanvasViewer
          canvas={canvas}
          background={previewBg}
          pickMode={!!pickMode}
          onPick={onPick}
          overlay={overlay}
          onCanvasClick={onCanvasClick}
        />
      </div>
      {helperText && (
        <div className="px-3 py-1.5 border-t border-border text-[11px] text-primary text-center bg-primary/5">
          {helperText}
        </div>
      )}
    </div>
  );
}

function ActionBar({
  primary,
  secondary,
}: {
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3">
      {primary}
      {secondary && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {secondary}
        </div>
      )}
    </div>
  );
}

/**
 * Analyze the background by binning every pixel of the whole image and
 * picking the most populous color bin. Returns:
 *   - color : the modal color (5-bit binning). For typical invitations
 *             and graphics where the BG fills the majority of the canvas,
 *             this is overwhelmingly the BG even when flowers/borders
 *             cover the perimeter.
 *   - noise : the mean per-channel distance of pixels NEAR the modal
 *             color (within ~30 RGB) from that color. Filtering out
 *             non-BG pixels keeps the noise estimate honest — design
 *             elements don't inflate it.
 *
 * Whole-image sampling beats perimeter sampling on designs where corner
 * decorations cover the edges (flowers, borders, butterflies). Subsamples
 * with stride so it stays fast on big images.
 */
function analyzeBackground(canvas: HTMLCanvasElement): {
  color: string;
  noise: number;
} {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { color: "#ffffff", noise: 0 };

  const fullImg = ctx.getImageData(0, 0, w, h);
  const data = fullImg.data;
  const totalPixels = w * h;

  // Aim for ~50 k samples — enough resolution for the histogram, fast
  // enough on a 4000 × 6000 image to run in a few ms.
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / 50000)));

  // 5-bit binning (32³ = 32 768 buckets). Real BG color collapses into
  // one or two adjacent buckets; design colors spread thin across many.
  const bins = new Map<number, number>();
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4;
      // Skip already-transparent pixels (shouldn't happen on the original,
      // but defensive in case the canvas was prepped elsewhere).
      if (data[i + 3] < 128) continue;
      const r5 = data[i] >> 3;
      const g5 = data[i + 1] >> 3;
      const b5 = data[i + 2] >> 3;
      const key = (r5 << 10) | (g5 << 5) | b5;
      bins.set(key, (bins.get(key) ?? 0) + 1);
    }
  }

  let bestKey = 0;
  let bestCount = 0;
  for (const [key, count] of bins) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const r = ((bestKey >> 10) & 0x1f) * 8 + 4;
  const g = ((bestKey >> 5) & 0x1f) * 8 + 4;
  const b = (bestKey & 0x1f) * 8 + 4;

  // Measure noise only from pixels close to the modal color (within 30
  // RGB units mean per-channel). This prevents design elements from
  // inflating the variance estimate.
  let noiseSum = 0;
  let noiseN = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(data[i] - r);
      const dg = Math.abs(data[i + 1] - g);
      const db = Math.abs(data[i + 2] - b);
      const meanDiff = (dr + dg + db) / 3;
      if (meanDiff > 30) continue; // not a BG candidate
      noiseSum += meanDiff;
      noiseN++;
    }
  }
  const noise = noiseN > 0 ? noiseSum / noiseN : 0;

  return { color: rgbToHex(r, g, b), noise };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Friendly color name for UI copy ("Remove all white" / "Remove all black"
 * reads better than "Remove all #FEFEFE"). Falls back to the hex when the
 * color isn't an obvious one.
 */
function bgColorName(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.1) {
    if (luma > 230) return "white";
    if (luma < 25) return "black";
    if (luma > 180) return "light gray";
    if (luma < 80) return "dark gray";
    return "gray";
  }
  // For colored BGs the hex is more informative than a guessed color name.
  return hex.toUpperCase();
}

/**
 * Choose restore mode based on the picked color: high-saturation, mid-luma
 * colors are likely thin text or vector logos → solid mode for crisp uniform
 * fill. Pastels and gradients → original mode to preserve shading.
 */
function pickRestoreMode(hex: string): "solid" | "original" {
  const { r, g, b } = hexToRgb(hex);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat > 0.55 && luma > 40 && luma < 220) return "solid";
  return "original";
}
