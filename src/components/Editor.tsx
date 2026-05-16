"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Download,
  Image as ImageIcon,
  LifeBuoy,
  Maximize2,
  Move,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  Zap,
} from "lucide-react";

import { Logo, Wordmark } from "@/components/Logo";
import { FileChip, Uploader } from "@/components/Uploader";
import { CanvasViewer, type BackgroundMode } from "@/components/CanvasViewer";
import { BackgroundSelector } from "@/components/BackgroundSelector";
import { SmartSuggestion } from "@/components/SmartSuggestion";
import { HistoryBreadcrumbs, type HistoryStep } from "@/components/HistoryBreadcrumbs";
import {
  BgRemovalPanel,
  type AiParams,
  type ChromakeyParams,
  type DtfFinishOptions,
} from "@/components/panels/BgRemovalPanel";
import { ResizePanel, type ResizeParams } from "@/components/panels/ResizePanel";
import { TransformPanel } from "@/components/panels/TransformPanel";
import { EffectsPanel } from "@/components/panels/EffectsPanel";
import { EnhancePanel } from "@/components/panels/EnhancePanel";
import { RepairPanel, type RepairParams } from "@/components/panels/RepairPanel";
import { PresetTrainer } from "@/components/PresetTrainer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AccordionSection } from "@/components/ui/Accordion";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

import { chromakey } from "@/lib/image/chromakey";
import { removeBackgroundAi } from "@/lib/image/aiRemoval";
import { autoCropTransparent } from "@/lib/image/crop";
import { canvasToBlob, resizeImage, setPngDpi } from "@/lib/image/resize";
import {
  enhanceGraphic,
  enhancePhoto,
  type GraphicAdjustments,
  type PhotoAdjustments,
} from "@/lib/image/enhance";
import { detectImageType, type DetectionResult } from "@/lib/image/detect";
import { loadImage, imageToCanvas } from "@/lib/image/canvas";
import {
  applyAlphaThreshold,
  mirrorHorizontal,
  mirrorVertical,
  rotateDegrees,
} from "@/lib/image/transform";
import {
  despill as despillFn,
  dropShadow,
  flattenBackground,
  grayscale as grayscaleFn,
  invert as invertFn,
  outline,
  replaceColor,
  sepia as sepiaFn,
} from "@/lib/image/effects";
import { restoreColor } from "@/lib/image/restore";
import { downloadBlob, formatBytes } from "@/lib/utils";

type Section =
  | "background"
  | "repair"
  | "enhance"
  | "transform"
  | "effects"
  | "resize";

const MAX_HISTORY = 20;

interface HistoryEntry {
  canvas: HTMLCanvasElement;
  label: string;
}

export function Editor() {
  const [file, setFile] = useState<File | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [previewBg, setPreviewBg] = useState<BackgroundMode>("transparent");
  const [openSection, setOpenSection] = useState<Section | null>("background");
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ stage: string; pct: number } | null>(null);
  const [pickColorMode, setPickColorMode] = useState(false);
  const [pickedColor, setPickedColor] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [presetsRefreshKey, setPresetsRefreshKey] = useState(0);

  const originalEntry = history[0] ?? null;
  const currentEntry = historyIndex >= 0 ? history[historyIndex] : null;
  const currentCanvas = currentEntry?.canvas ?? null;
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const pushHistory = useCallback(
    (canvas: HTMLCanvasElement, label: string) => {
      setHistory((prev) => {
        const truncated = prev.slice(0, historyIndex + 1);
        truncated.push({ canvas, label });
        if (truncated.length > MAX_HISTORY) {
          truncated.splice(0, truncated.length - MAX_HISTORY);
        }
        return truncated;
      });
      setHistoryIndex((prev) => Math.min(prev + 1, MAX_HISTORY - 1));
    },
    [historyIndex]
  );

  // Auto-cancel picker mode when section changes.
  useEffect(() => {
    setPickColorMode(false);
  }, [openSection]);

  const handleFile = useCallback(async (uploadedFile: File) => {
    setFile(uploadedFile);
    try {
      const img = await loadImage(uploadedFile);
      const canvas = imageToCanvas(img);
      setHistory([{ canvas, label: "Original" }]);
      setHistoryIndex(0);
      const det = detectImageType(canvas);
      setDetection(det);
      if (det.recommendedAction === "ready-to-resize") setOpenSection("resize");
      else setOpenSection("background");
      toast.success("Image loaded", {
        description: `${img.naturalWidth} × ${img.naturalHeight} px · ${formatBytes(uploadedFile.size)}`,
      });
    } catch {
      toast.error("Failed to load image");
    }
  }, []);

  const handleUndo = useCallback(() => {
    if (canUndo) {
      setHistoryIndex(historyIndex - 1);
    }
  }, [canUndo, historyIndex]);

  const handleRedo = useCallback(() => {
    if (canRedo) {
      setHistoryIndex(historyIndex + 1);
    }
  }, [canRedo, historyIndex]);

  const handleJump = useCallback(
    (index: number) => {
      if (index >= 0 && index < history.length) {
        setHistoryIndex(index);
      }
    },
    [history.length]
  );

  const handleBackToOriginal = useCallback(() => {
    if (history.length > 0) {
      setHistoryIndex(0);
      toast.info("Back to original — your steps are preserved (use redo to come back)");
    }
  }, [history.length]);

  const handleStartOver = useCallback(() => {
    if (originalEntry) {
      setHistory([originalEntry]);
      setHistoryIndex(0);
      toast.info("Started over — all changes cleared");
    }
    setConfirmStartOver(false);
  }, [originalEntry]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleUndo, handleRedo]);

  // ─── Operations ────────────────────────────────────────────────────────

  const runProcessing = useCallback(
    async <T,>(fn: () => Promise<T>) => {
      setIsProcessing(true);
      try {
        // Yield to UI so spinners render before heavy CPU work.
        await new Promise((r) => setTimeout(r, 16));
        return await fn();
      } finally {
        setIsProcessing(false);
      }
    },
    []
  );

  /**
   * Applies the DTF "finishing" pipeline after a background-removal pass:
   *   1. Despill (decontaminate edge pixels) — only when source color is known.
   *   2. Solid edges (alpha threshold + choke) — every pixel becomes 0 or 255.
   *
   * Returns the (possibly transformed) canvas plus a label describing the work done.
   */
  const applyDtfFinish = useCallback(
    (
      input: HTMLCanvasElement,
      finish: DtfFinishOptions,
      removedColor?: string
    ): { canvas: HTMLCanvasElement; label: string } => {
      let out = input;
      const parts: string[] = [];

      if (finish.despill && removedColor) {
        out = despillFn(out, removedColor);
        parts.push("despill");
      }
      if (finish.solidEdges) {
        out = applyAlphaThreshold(out, {
          threshold: finish.alphaThreshold,
          choke: finish.choke,
        });
        parts.push("solid edges");
      }
      const label =
        parts.length > 0 ? ` + ${parts.join(" + ")}` : "";
      return { canvas: out, label };
    },
    []
  );

  const handleApplyChromakey = useCallback(
    async (params: ChromakeyParams) => {
      if (!currentCanvas) return;
      try {
        await runProcessing(async () => {
          const img = new Image();
          const url = currentCanvas.toDataURL();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject();
            img.src = url;
          });
          let result = await chromakey(img, {
            color: params.color,
            tolerance: params.tolerance,
            strategy: params.strategy,
            edgeFeather: params.edgeFeather,
          });
          const finished = applyDtfFinish(result, params.finish, params.color);
          result = finished.canvas;
          pushHistory(result, `BG Removed${finished.label}`);
        });
        toast.success("Background removed", {
          description: params.finish.solidEdges
            ? "Edges hardened — ready for crisp DTF print."
            : undefined,
        });
      } catch (e) {
        console.error(e);
        toast.error("Background removal failed");
      }
    },
    [currentCanvas, pushHistory, runProcessing, applyDtfFinish]
  );

  const handleApplyAi = useCallback(
    async (params: AiParams) => {
      if (!currentCanvas) return;
      setIsProcessing(true);
      setAiProgress({ stage: "Preparing…", pct: 0 });
      try {
        const blob = await canvasToBlob(currentCanvas, "image/png");
        const result = await removeBackgroundAi(blob, {
          quality: params.quality,
          onProgress: (key, current, total) => {
            const pct = total > 0 ? (current / total) * 100 : 0;
            const stage = key.includes("download")
              ? "Downloading AI model…"
              : key.includes("compute") || key.includes("inference")
                ? "Analyzing image…"
                : "Processing…";
            setAiProgress({ stage, pct });
          },
        });
        const img = await loadImage(result);
        let canvas = imageToCanvas(img);
        // No source color for AI removal → skip despill step.
        const finished = applyDtfFinish(canvas, {
          ...params.finish,
          despill: false,
        });
        canvas = finished.canvas;
        pushHistory(canvas, `AI BG Removed${finished.label}`);
        toast.success("AI background removal complete", {
          description: params.finish.solidEdges
            ? "Edges hardened — ready for crisp DTF print."
            : undefined,
        });
      } catch (e) {
        console.error(e);
        toast.error("AI removal failed", {
          description: "Try the color-based removal or check your connection.",
        });
      } finally {
        setIsProcessing(false);
        setAiProgress(null);
      }
    },
    [currentCanvas, pushHistory, applyDtfFinish]
  );

  const handleAutoCrop = useCallback(async () => {
    if (!currentCanvas) return;
    try {
      await runProcessing(async () => {
        const cropped = autoCropTransparent(currentCanvas);
        pushHistory(cropped, "Cropped");
        toast.success("Cropped to content", {
          description: `${cropped.width} × ${cropped.height} px`,
        });
      });
    } catch (e) {
      console.error(e);
      toast.error("Crop failed");
    }
  }, [currentCanvas, pushHistory, runProcessing]);

  const handleResize = useCallback(
    async (params: ResizeParams) => {
      if (!currentCanvas) return;
      try {
        await runProcessing(async () => {
          const result = await resizeImage(currentCanvas, params);
          pushHistory(result, `Resized ${result.width}×${result.height}`);
          toast.success("Resized", {
            description: `${result.width} × ${result.height} px${
              params.units !== "px" ? ` · ${params.dpi} DPI` : ""
            }`,
          });
        });
      } catch (e) {
        console.error(e);
        toast.error("Resize failed");
      }
    },
    [currentCanvas, pushHistory, runProcessing]
  );

  const handleEnhancePhoto = useCallback(
    async (adj: PhotoAdjustments) => {
      if (!currentCanvas) return;
      try {
        await runProcessing(async () => {
          const result = enhancePhoto(currentCanvas, adj);
          pushHistory(result, "Photo Enhanced");
        });
        toast.success("Photo enhanced");
      } catch (e) {
        console.error(e);
        toast.error("Enhancement failed");
      }
    },
    [currentCanvas, pushHistory, runProcessing]
  );

  const handleEnhanceGraphic = useCallback(
    async (adj: GraphicAdjustments) => {
      if (!currentCanvas) return;
      try {
        await runProcessing(async () => {
          const result = enhanceGraphic(currentCanvas, adj);
          pushHistory(result, "Design Enhanced");
        });
        toast.success("Design enhanced");
      } catch (e) {
        console.error(e);
        toast.error("Enhancement failed");
      }
    },
    [currentCanvas, pushHistory, runProcessing]
  );

  // ─── Transform handlers ────────────────────────────────────────────────

  const runSync = useCallback(
    (fn: () => HTMLCanvasElement, label: string, successMsg?: string) => {
      if (!currentCanvas) return;
      runProcessing(async () => {
        const out = fn();
        pushHistory(out, label);
        if (successMsg) toast.success(successMsg);
      }).catch((e) => {
        console.error(e);
        toast.error("Operation failed");
      });
    },
    [currentCanvas, pushHistory, runProcessing]
  );

  const handleMirrorH = useCallback(() => {
    if (!currentCanvas) return;
    runSync(
      () => mirrorHorizontal(currentCanvas),
      "Mirrored ⇆",
      "Mirrored horizontally — ready for DTF transfer"
    );
  }, [currentCanvas, runSync]);

  const handleMirrorV = useCallback(() => {
    if (!currentCanvas) return;
    runSync(() => mirrorVertical(currentCanvas), "Mirrored ⇅", "Mirrored vertically");
  }, [currentCanvas, runSync]);

  const handleRotate = useCallback(
    (degrees: number) => {
      if (!currentCanvas) return;
      runSync(
        () => rotateDegrees(currentCanvas, degrees),
        `Rotated ${degrees}°`,
        `Rotated ${degrees}°`
      );
    },
    [currentCanvas, runSync]
  );

  const handleApplyAlphaThreshold = useCallback(
    (threshold: number, choke: number) => {
      if (!currentCanvas) return;
      runSync(
        () => applyAlphaThreshold(currentCanvas, { threshold, choke }),
        "Solid Edges",
        "Edges hardened — ready for crisp DTF print"
      );
    },
    [currentCanvas, runSync]
  );

  // ─── Effects handlers ──────────────────────────────────────────────────

  const handleDropShadow = useCallback(
    (p: { offsetX: number; offsetY: number; blur: number; color: string; opacity: number }) => {
      if (!currentCanvas) return;
      runSync(() => dropShadow(currentCanvas, p), "Drop Shadow", "Shadow added");
    },
    [currentCanvas, runSync]
  );

  const handleOutline = useCallback(
    (p: { width: number; color: string }) => {
      if (!currentCanvas) return;
      runSync(() => outline(currentCanvas, p), "Outline", "Outline added");
    },
    [currentCanvas, runSync]
  );

  const handleReplaceColor = useCallback(
    (p: { fromColor: string; toColor: string; tolerance: number; preserveLuma: boolean }) => {
      if (!currentCanvas) return;
      runSync(() => replaceColor(currentCanvas, p), "Color Replaced", "Color replaced");
    },
    [currentCanvas, runSync]
  );

  const handleGrayscale = useCallback(() => {
    if (!currentCanvas) return;
    runSync(() => grayscaleFn(currentCanvas), "B&W", "Converted to black & white");
  }, [currentCanvas, runSync]);

  const handleSepia = useCallback(() => {
    if (!currentCanvas) return;
    runSync(() => sepiaFn(currentCanvas), "Sepia", "Sepia tone applied");
  }, [currentCanvas, runSync]);

  const handleInvert = useCallback(() => {
    if (!currentCanvas) return;
    runSync(() => invertFn(currentCanvas), "Inverted", "Colors inverted");
  }, [currentCanvas, runSync]);

  const handleFlattenBackground = useCallback(
    (color: string) => {
      if (!currentCanvas) return;
      runSync(
        () => flattenBackground(currentCanvas, color),
        "Flattened",
        "Flattened onto solid background"
      );
    },
    [currentCanvas, runSync]
  );

  // ─── Repair handler ────────────────────────────────────────────────────

  const handleRepair = useCallback(
    async (params: RepairParams) => {
      if (!currentCanvas || !originalEntry) return;
      try {
        await runProcessing(async () => {
          const { canvas, pixelsRestored } = restoreColor(
            currentCanvas,
            originalEntry.canvas,
            params
          );
          if (pixelsRestored === 0) {
            toast.info("No matching pixels to restore", {
              description:
                "Try increasing color match range or search radius, or pick a different color.",
            });
            return;
          }
          pushHistory(canvas, `Restored ${params.color.toUpperCase()}`);
          toast.success(
            `Restored ${pixelsRestored.toLocaleString()} pixel${pixelsRestored === 1 ? "" : "s"}`,
            {
              description:
                params.mode === "solid"
                  ? "Filled as one solid color — perfect for clean text."
                  : "Restored from original — shading preserved.",
            }
          );
        });
      } catch (e) {
        console.error(e);
        toast.error("Restore failed");
      }
    },
    [currentCanvas, originalEntry, pushHistory, runProcessing]
  );

  const handleNewImage = useCallback(() => {
    setFile(null);
    setHistory([]);
    setHistoryIndex(-1);
    setDetection(null);
    setOpenSection("background");
  }, []);

  const handleDownload = useCallback(async () => {
    if (!currentCanvas || !file) return;
    setIsProcessing(true);
    try {
      let blob = await canvasToBlob(currentCanvas, "image/png");
      blob = await setPngDpi(blob, 300);
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      downloadBlob(blob, `${baseName} - thevectorkit.png`);
      toast.success("Downloaded", {
        description: `${currentCanvas.width} × ${currentCanvas.height} px · ${formatBytes(blob.size)}`,
      });
    } catch (e) {
      console.error(e);
      toast.error("Download failed");
    } finally {
      setIsProcessing(false);
    }
  }, [currentCanvas, file]);

  const handleSuggestionAction = useCallback(
    (action: DetectionResult["recommendedAction"]) => {
      if (action === "ready-to-resize") setOpenSection("resize");
      else if (action === "remove-bg-ai" || action === "remove-bg-color") {
        setOpenSection("background");
      } else if (action === "enhance-photo") setOpenSection("enhance");
    },
    []
  );

  const breadcrumbSteps: HistoryStep[] = history.map((h) => ({ label: h.label }));

  // Track which sections have applied changes (for accordion badges).
  const sectionUsed = useRef<Set<Section>>(new Set());
  useEffect(() => {
    // When a step is added, infer which section was used by its label.
    if (history.length <= 1) {
      sectionUsed.current = new Set();
      return;
    }
    const last = history[history.length - 1].label;
    if (last.includes("BG")) sectionUsed.current.add("background");
    else if (last.startsWith("Restored")) sectionUsed.current.add("repair");
    else if (last.includes("Enhanced")) sectionUsed.current.add("enhance");
    else if (
      last.includes("Cropped") ||
      last.includes("Mirrored") ||
      last.includes("Rotated") ||
      last.includes("Solid Edges")
    )
      sectionUsed.current.add("transform");
    else if (
      last.includes("Shadow") ||
      last.includes("Outline") ||
      last.includes("Color Replaced") ||
      last.includes("B&W") ||
      last.includes("Sepia") ||
      last.includes("Inverted") ||
      last.includes("Flattened")
    )
      sectionUsed.current.add("effects");
    else if (last.includes("Resized")) sectionUsed.current.add("resize");
  }, [history]);

  if (!file || !currentCanvas) {
    return <LandingPage onFile={handleFile} />;
  }

  const toggleSection = (s: Section) =>
    setOpenSection((prev) => (prev === s ? null : s));

  const sectionBadge = (s: Section) =>
    sectionUsed.current.has(s) ? (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-success bg-success/10 px-1.5 py-0.5 rounded">
        <Check className="h-2.5 w-2.5" />
        Done
      </span>
    ) : null;

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-3">
          <Logo className="h-7 w-7" />
          <Wordmark className="text-base" />
          <div className="hidden md:block ml-4">
            <FileChip file={file} />
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToOriginal}
            disabled={historyIndex === 0}
            title="Back to original (keeps your steps for redo)"
          >
            <RotateCcw className="h-4 w-4" /> Original
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmStartOver(true)}
            disabled={history.length <= 1}
            title="Start over and discard all changes"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Start Over
          </Button>
          <div className="w-px h-6 bg-border mx-1" />
          <Button variant="ghost" size="sm" onClick={handleNewImage}>
            <ImageIcon className="h-4 w-4" /> New
          </Button>
          <Button variant="gradient" size="sm" onClick={handleDownload} disabled={isProcessing}>
            <Download className="h-4 w-4" /> Download PNG
          </Button>
        </div>
      </header>

      {/* Smart Suggestion */}
      {detection && historyIndex === 0 && (
        <SmartSuggestion detection={detection} onActOn={handleSuggestionAction} />
      )}

      {/* Main split layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Side panel (accordion) */}
        <aside className="w-[380px] border-r border-border bg-muted/30 overflow-y-auto shrink-0">
          <AccordionSection
            open={openSection === "background"}
            onToggle={() => toggleSection("background")}
            title="Remove Background"
            icon={<Wand2 className="h-4 w-4" />}
            badge={sectionBadge("background")}
          >
            <BgRemovalPanel
              onApplyChromakey={handleApplyChromakey}
              onApplyAi={handleApplyAi}
              onPickColorMode={setPickColorMode}
              pickedColor={pickedColor}
              isProcessing={isProcessing}
              aiProgress={aiProgress}
              onOpenTrainer={() => setTrainerOpen(true)}
              presetsRefreshKey={presetsRefreshKey}
            />
          </AccordionSection>

          <AccordionSection
            open={openSection === "repair"}
            onToggle={() => toggleSection("repair")}
            title="Repair Design"
            icon={<LifeBuoy className="h-4 w-4" />}
            badge={sectionBadge("repair")}
          >
            <RepairPanel
              onApply={handleRepair}
              onPickColorMode={setPickColorMode}
              pickedColor={pickedColor}
              isProcessing={isProcessing}
              hasOriginal={!!originalEntry}
            />
          </AccordionSection>

          <AccordionSection
            open={openSection === "enhance"}
            onToggle={() => toggleSection("enhance")}
            title="Enhance Image"
            icon={<Sparkles className="h-4 w-4" />}
            badge={sectionBadge("enhance")}
          >
            <EnhancePanel
              isProcessing={isProcessing}
              detectedType={detection?.type ?? null}
              onApplyPhoto={handleEnhancePhoto}
              onApplyGraphic={handleEnhanceGraphic}
            />
          </AccordionSection>

          <AccordionSection
            open={openSection === "transform"}
            onToggle={() => toggleSection("transform")}
            title="Transform & Crop"
            icon={<Move className="h-4 w-4" />}
            badge={sectionBadge("transform")}
          >
            <TransformPanel
              isProcessing={isProcessing}
              onMirrorH={handleMirrorH}
              onMirrorV={handleMirrorV}
              onRotate={handleRotate}
              onAutoCrop={handleAutoCrop}
              onApplyAlphaThreshold={handleApplyAlphaThreshold}
            />
          </AccordionSection>

          <AccordionSection
            open={openSection === "effects"}
            onToggle={() => toggleSection("effects")}
            title="Effects & Recolor"
            icon={<Zap className="h-4 w-4" />}
            badge={sectionBadge("effects")}
          >
            <EffectsPanel
              isProcessing={isProcessing}
              onDropShadow={handleDropShadow}
              onOutline={handleOutline}
              onReplaceColor={handleReplaceColor}
              onGrayscale={handleGrayscale}
              onSepia={handleSepia}
              onInvert={handleInvert}
              onFlattenBackground={handleFlattenBackground}
            />
          </AccordionSection>

          <AccordionSection
            open={openSection === "resize"}
            onToggle={() => toggleSection("resize")}
            title="Resize for Print"
            icon={<Maximize2 className="h-4 w-4" />}
            badge={sectionBadge("resize")}
          >
            <ResizePanel
              currentWidth={currentCanvas.width}
              currentHeight={currentCanvas.height}
              isProcessing={isProcessing}
              onApply={handleResize}
            />
          </AccordionSection>
        </aside>

        {/* Canvas area */}
        <main className="flex-1 flex flex-col min-w-0">
          {/* Canvas top bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/30 gap-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
              <span className="font-mono whitespace-nowrap">
                {currentCanvas.width} × {currentCanvas.height} px
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <HistoryBreadcrumbs
                steps={breadcrumbSteps}
                currentIndex={historyIndex}
                onJump={handleJump}
              />
            </div>
            <BackgroundSelector value={previewBg} onChange={setPreviewBg} />
          </div>

          {/* Canvas viewer */}
          <div className="flex-1 p-4 min-h-0">
            <CanvasViewer
              canvas={currentCanvas}
              background={previewBg}
              pickMode={pickColorMode}
              onPick={(hex) => {
                setPickedColor(hex);
                toast.success(`Picked color ${hex.toUpperCase()}`);
              }}
            />
          </div>

          {/* Hint footer */}
          <div className="px-4 py-1.5 border-t border-border bg-card/30 text-[11px] text-muted-foreground flex items-center justify-center gap-4">
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">scroll</kbd> zoom</span>
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">drag</kbd> pan when zoomed</span>
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">+ −</kbd> zoom</span>
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">0</kbd> fit</span>
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">1</kbd> 100%</span>
            <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">Ctrl+Z</kbd> undo</span>
          </div>
        </main>
      </div>

      <ConfirmDialog
        open={confirmStartOver}
        title="Start over?"
        description={
          <>
            This will clear all <strong>{history.length - 1}</strong> step{history.length - 1 === 1 ? "" : "s"} of your work
            and reset to the original image. This can&apos;t be undone.
          </>
        }
        confirmLabel="Yes, start over"
        cancelLabel="Keep my work"
        destructive
        onConfirm={handleStartOver}
        onCancel={() => setConfirmStartOver(false)}
      />

      <PresetTrainer
        open={trainerOpen}
        initialSample={
          currentCanvas && file
            ? { name: file.name, canvas: currentCanvas }
            : null
        }
        onClose={() => setTrainerOpen(false)}
        onPresetSaved={() => setPresetsRefreshKey((k) => k + 1)}
      />
    </div>
  );
}

function LandingPage({ onFile }: { onFile: (f: File) => void }) {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Logo className="h-9 w-9" />
          <Wordmark className="text-xl" />
        </div>
        <a
          href="#features"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Features
        </a>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 py-16">
        <div className="max-w-3xl w-full text-center mb-10">
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-primary bg-primary/10 px-3 py-1 rounded-full mb-6">
            <Sparkles className="h-3.5 w-3.5" />
            Free · No signup · Privacy-first
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-4">
            Print-ready images in <span className="brand-gradient-text">seconds</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Remove backgrounds, enhance photos and graphics, resize for DTF print at 300 DPI — all
            in your browser. Your images never leave your device.
          </p>
        </div>

        <Uploader onFile={onFile} className="mb-12" />

        <section id="features" className="max-w-5xl w-full mt-16 grid md:grid-cols-3 gap-4">
          <FeatureCard
            icon={<Wand2 className="h-5 w-5" />}
            title="Pro Background Removal"
            description="Color, flood-fill, or AI removal — with auto despill and solid-edge thresholding so every pixel prints crisp on DTF film."
          />
          <FeatureCard
            icon={<Sparkles className="h-5 w-5" />}
            title="One-Click Enhance"
            description="Auto-enhance for photos: brightness, color, sharpness. Punch-up for logos: contrast, vibrance, edge cleanup."
          />
          <FeatureCard
            icon={<Move className="h-5 w-5" />}
            title="Mirror, Rotate, Crop"
            description="One-tap mirror for DTF transfer printing. Rotate, auto-crop, and re-harden alpha edges after any operation."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="Shadows, Outlines & Recolor"
            description="Add drop shadows, colored outlines, replace any color while preserving shading. Flatten on solid backgrounds for JPG export."
          />
          <FeatureCard
            icon={<Maximize2 className="h-5 w-5" />}
            title="Print Presets @ 300 DPI"
            description="One click for shirt fronts, pockets, stickers, hats, mugs — sized at exact inches @ 300 DPI."
          />
          <FeatureCard
            icon={<Undo2 className="h-5 w-5" />}
            title="Zoom, Pan & 20-Step Undo"
            description="Inspect every pixel with mouse-wheel zoom. Full undo/redo and breadcrumb history."
          />
        </section>
      </main>

      <footer className="border-t border-border py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} TheVectorKit · All processing happens in your browser
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            {icon}
          </div>
          <CardTitle>{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
