"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Check,
  ChevronRight,
  ImagePlus,
  Loader2,
  Save,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { CanvasViewer, type BackgroundMode } from "@/components/CanvasViewer";
import { BackgroundSelector } from "@/components/BackgroundSelector";
import { cn } from "@/lib/utils";

import type {
  ChromakeyParams,
  DtfFinishOptions,
} from "@/components/panels/BgRemovalPanel";
import { chromakey } from "@/lib/image/chromakey";
import { applyAlphaThreshold } from "@/lib/image/transform";
import { despill as despillFn } from "@/lib/image/effects";
import { loadImage, imageToCanvas } from "@/lib/image/canvas";
import {
  applyCritique,
  applyCritiques,
  CRITIQUES,
  parseFreeformCritique,
  aggregateSamples,
  type CritiqueId,
  type TrainingSample,
} from "@/lib/trainer";
import {
  generateCustomId,
  saveCustomPreset,
  type CustomPreset,
} from "@/lib/customPresets";

interface PresetTrainerProps {
  open: boolean;
  /** Optional starting params (e.g. existing preset to refine). */
  initialParams?: ChromakeyParams;
  /** Optional initial sample (e.g. the canvas the user already loaded). */
  initialSample?: { name: string; canvas: HTMLCanvasElement } | null;
  onClose: () => void;
  /** Fired after a preset is saved successfully. Parent can refresh its preset list. */
  onPresetSaved?: (preset: CustomPreset) => void;
}

const DEFAULT_FINISH: DtfFinishOptions = {
  solidEdges: true,
  alphaThreshold: 128,
  choke: 1,
  despill: true,
};

const DEFAULT_PARAMS: ChromakeyParams = {
  color: "#ffffff",
  tolerance: 12,
  strategy: "flood",
  edgeFeather: 1,
  finish: DEFAULT_FINISH,
};

export function PresetTrainer({
  open,
  initialParams,
  initialSample,
  onClose,
  onPresetSaved,
}: PresetTrainerProps) {
  const [params, setParams] = useState<ChromakeyParams>(
    initialParams ?? DEFAULT_PARAMS
  );
  const [paramHistory, setParamHistory] = useState<ChromakeyParams[]>([]);
  const [samples, setSamples] = useState<TrainingSample[]>([]);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [resultCanvas, setResultCanvas] = useState<HTMLCanvasElement | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewBg, setPreviewBg] = useState<BackgroundMode>("transparent");
  const [freeform, setFreeform] = useState("");
  const [explanationLog, setExplanationLog] = useState<string[]>([]);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [presetIcon, setPresetIcon] = useState("⭐");
  const [presetNotes, setPresetNotes] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runIdRef = useRef(0);

  // Reset when modal opens fresh.
  useEffect(() => {
    if (!open) return;
    setParams(initialParams ?? DEFAULT_PARAMS);
    setParamHistory([]);
    setExplanationLog([]);
    setFreeform("");
    setSavePromptOpen(false);

    // If parent passed an initial sample, seed it.
    if (initialSample) {
      const id = `sample-${Date.now()}`;
      const sample: TrainingSample = {
        id,
        name: initialSample.name,
        source: initialSample.canvas,
        critiques: [],
        acceptedParams: null,
      };
      setSamples([sample]);
      setActiveSampleId(id);
    } else {
      setSamples([]);
      setActiveSampleId(null);
      setResultCanvas(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeSample = useMemo(
    () => samples.find((s) => s.id === activeSampleId) ?? null,
    [samples, activeSampleId]
  );

  // ─── Pipeline ────────────────────────────────────────────────────────────

  const runPipeline = useCallback(
    async (source: HTMLCanvasElement, p: ChromakeyParams) => {
      const img = new Image();
      const url = source.toDataURL();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image decode failed"));
        img.src = url;
      });
      let out = await chromakey(img, {
        color: p.color,
        tolerance: p.tolerance,
        strategy: p.strategy,
        edgeFeather: p.edgeFeather,
      });
      if (p.finish.despill) out = despillFn(out, p.color);
      if (p.finish.solidEdges) {
        out = applyAlphaThreshold(out, {
          threshold: p.finish.alphaThreshold,
          choke: p.finish.choke,
        });
      }
      return out;
    },
    []
  );

  // Re-run pipeline whenever active sample or params change.
  useEffect(() => {
    if (!open || !activeSample) {
      setResultCanvas(null);
      return;
    }
    const myRunId = ++runIdRef.current;
    setIsProcessing(true);
    (async () => {
      try {
        // Yield so spinner renders before heavy CPU.
        await new Promise((r) => setTimeout(r, 16));
        const out = await runPipeline(activeSample.source, params);
        if (runIdRef.current === myRunId) setResultCanvas(out);
      } catch (e) {
        console.error(e);
        toast.error("Pipeline failed");
      } finally {
        if (runIdRef.current === myRunId) setIsProcessing(false);
      }
    })();
  }, [open, activeSample, params, runPipeline]);

  // ─── Sample management ──────────────────────────────────────────────────

  const handleAddSample = () => fileInputRef.current?.click();

  const onFileChosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const img = await loadImage(file);
      const canvas = imageToCanvas(img);
      const id = `sample-${Date.now()}`;
      const sample: TrainingSample = {
        id,
        name: file.name,
        source: canvas,
        critiques: [],
        acceptedParams: null,
      };
      setSamples((prev) => [...prev, sample]);
      setActiveSampleId(id);
      toast.success(`Loaded ${file.name}`);
    } catch {
      toast.error("Couldn't load that image");
    }
  };

  const handleRemoveSample = (id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
    if (activeSampleId === id) {
      const remaining = samples.filter((s) => s.id !== id);
      setActiveSampleId(remaining[0]?.id ?? null);
    }
  };

  const handleAcceptSample = () => {
    if (!activeSample) return;
    setSamples((prev) =>
      prev.map((s) =>
        s.id === activeSample.id ? { ...s, acceptedParams: { ...params, finish: { ...params.finish } } } : s
      )
    );
    toast.success(`Marked "${activeSample.name}" as good`, {
      description: "These params will be averaged into the final preset.",
    });
  };

  // ─── Critique application ──────────────────────────────────────────────

  const applyOne = (critiqueId: CritiqueId) => {
    const { next, explanation } = applyCritique(params, critiqueId);
    setParamHistory((prev) => [...prev, params]);
    setParams(next);
    setExplanationLog((prev) => [
      `${CRITIQUES.find((c) => c.id === critiqueId)?.label ?? critiqueId}: ${explanation}`,
      ...prev,
    ]);
    if (activeSample) {
      setSamples((prev) =>
        prev.map((s) =>
          s.id === activeSample.id
            ? { ...s, critiques: [...s.critiques, critiqueId] }
            : s
        )
      );
    }
  };

  const applyFreeform = () => {
    const text = freeform.trim();
    if (!text) return;
    const matches = parseFreeformCritique(text);
    if (matches.length === 0) {
      toast.info("Couldn't map that to an adjustment", {
        description:
          "Try a chip, or rephrase using words like 'background still showing', 'halo on edges', 'white inside got eaten', etc.",
      });
      return;
    }
    const { next, explanations } = applyCritiques(params, matches);
    setParamHistory((prev) => [...prev, params]);
    setParams(next);
    setExplanationLog((prev) => [...explanations.reverse(), ...prev]);
    if (activeSample) {
      setSamples((prev) =>
        prev.map((s) =>
          s.id === activeSample.id
            ? { ...s, critiques: [...s.critiques, ...matches] }
            : s
        )
      );
    }
    setFreeform("");
    toast.success(
      matches.length === 1
        ? `Applied: ${CRITIQUES.find((c) => c.id === matches[0])?.label}`
        : `Applied ${matches.length} adjustments`
    );
  };

  const undoCritique = () => {
    setParamHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setParams(last);
      setExplanationLog((logPrev) => logPrev.slice(1));
      // Remove last critique from active sample.
      if (activeSample) {
        setSamples((sPrev) =>
          sPrev.map((s) =>
            s.id === activeSample.id
              ? { ...s, critiques: s.critiques.slice(0, -1) }
              : s
          )
        );
      }
      return prev.slice(0, -1);
    });
  };

  // ─── Save preset ───────────────────────────────────────────────────────

  const acceptedCount = samples.filter((s) => s.acceptedParams).length;
  const aggregatedParams = useMemo(() => aggregateSamples(samples), [samples]);

  const handleSaveClick = () => {
    if (!aggregatedParams) {
      toast.info("Mark at least one sample as good first", {
        description: "Click ✓ Mark Good once you're happy with how the preset works on a sample.",
      });
      return;
    }
    setPresetName("");
    setPresetIcon("⭐");
    setPresetNotes("");
    setSavePromptOpen(true);
  };

  const handleSaveConfirm = () => {
    if (!aggregatedParams) return;
    const trimmedName = presetName.trim();
    if (!trimmedName) {
      toast.error("Give the preset a name");
      return;
    }
    const preset: CustomPreset = {
      id: generateCustomId(trimmedName),
      name: trimmedName,
      icon: presetIcon || "⭐",
      description:
        presetNotes.trim() ||
        `Trained on ${acceptedCount} sample${acceptedCount === 1 ? "" : "s"}`,
      params: aggregatedParams,
      custom: true,
      createdAt: new Date().toISOString(),
      notes: presetNotes.trim() || undefined,
    };
    saveCustomPreset(preset);
    onPresetSaved?.(preset);
    toast.success(`Saved preset "${trimmedName}"`, {
      description: "Now available in Quick Presets.",
    });
    setSavePromptOpen(false);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col animate-fade-in">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-md brand-gradient flex items-center justify-center text-white">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold leading-none">Train a Preset</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Critique results live, the algo adjusts, save when it's dialed in.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="gradient"
            size="sm"
            onClick={handleSaveClick}
            disabled={!aggregatedParams}
            title={
              aggregatedParams
                ? "Save current params as a reusable preset"
                : "Mark at least one sample as good first"
            }
          >
            <Save className="h-4 w-4" /> Save Preset
            {acceptedCount > 0 && (
              <span className="ml-1 text-[10px] bg-white/20 rounded px-1.5 py-0.5">
                {acceptedCount} good
              </span>
            )}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left rail: samples + param readout */}
        <aside className="w-[300px] border-r border-border bg-muted/30 overflow-y-auto shrink-0 flex flex-col">
          <SampleList
            samples={samples}
            activeId={activeSampleId}
            onSelect={setActiveSampleId}
            onRemove={handleRemoveSample}
            onAdd={handleAddSample}
          />
          <ParamReadout params={params} />
          {explanationLog.length > 0 && (
            <ExplanationLog log={explanationLog} onUndo={undoCritique} />
          )}
        </aside>

        {/* Center: canvas */}
        <main className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/30">
            <div className="text-xs text-muted-foreground min-w-0 truncate">
              {activeSample ? (
                <>
                  Result: <span className="font-mono">{activeSample.name}</span>
                  {resultCanvas && (
                    <span className="ml-2 text-[11px]">
                      ({resultCanvas.width} × {resultCanvas.height} px)
                    </span>
                  )}
                </>
              ) : (
                "No sample loaded — add one to start"
              )}
            </div>
            <div className="flex items-center gap-2">
              {activeSample && (
                <Button
                  variant={
                    activeSample.acceptedParams ? "secondary" : "outline"
                  }
                  size="sm"
                  onClick={handleAcceptSample}
                  disabled={isProcessing}
                  title="Mark current params as good for this sample. They'll be averaged into the saved preset."
                >
                  <Check className="h-4 w-4" />
                  {activeSample.acceptedParams ? "Re-mark good" : "Mark good"}
                </Button>
              )}
              <BackgroundSelector value={previewBg} onChange={setPreviewBg} />
            </div>
          </div>
          <div className="flex-1 p-4 min-h-0 relative">
            {activeSample ? (
              <CanvasViewer
                canvas={resultCanvas}
                background={previewBg}
                pickMode={false}
              />
            ) : (
              <EmptyState onAdd={handleAddSample} />
            )}
            {isProcessing && (
              <div className="absolute top-6 right-6 bg-card/95 border border-border rounded-md px-3 py-1.5 shadow-md flex items-center gap-2 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                Re-processing…
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Footer: critiques */}
      <footer className="border-t border-border bg-card/50 shrink-0">
        <CritiqueRow onApply={applyOne} disabled={!activeSample} />
        <FreeformInput
          value={freeform}
          onChange={setFreeform}
          onSubmit={applyFreeform}
          disabled={!activeSample}
        />
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileChosen}
      />

      {savePromptOpen && (
        <SavePresetDialog
          name={presetName}
          icon={presetIcon}
          notes={presetNotes}
          aggregatedParams={aggregatedParams}
          acceptedCount={acceptedCount}
          onNameChange={setPresetName}
          onIconChange={setPresetIcon}
          onNotesChange={setPresetNotes}
          onConfirm={handleSaveConfirm}
          onCancel={() => setSavePromptOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function SampleList({
  samples,
  activeId,
  onSelect,
  onRemove,
  onAdd,
}: {
  samples: TrainingSample[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="p-3 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Test Images ({samples.length})
        </Label>
        <Button variant="ghost" size="sm" onClick={onAdd} className="h-7 px-2">
          <ImagePlus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {samples.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-2 text-center">
          Add an invitation design to start training.
        </p>
      ) : (
        <ul className="space-y-1">
          {samples.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => onSelect(s.id)}
                className={cn(
                  "w-full text-left rounded-md px-2 py-1.5 text-xs transition-colors flex items-center gap-2 group cursor-pointer",
                  s.id === activeId
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "hover:bg-muted border border-transparent"
                )}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform",
                    s.id === activeId && "rotate-90"
                  )}
                />
                <span className="flex-1 truncate font-mono text-[11px]">
                  {s.name}
                </span>
                {s.acceptedParams && (
                  <Check className="h-3 w-3 text-success shrink-0" />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(s.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity cursor-pointer"
                  title="Remove this sample"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </button>
              {s.critiques.length > 0 && (
                <div className="ml-5 mt-0.5 mb-1 text-[10px] text-muted-foreground">
                  {s.critiques.length} adjustment
                  {s.critiques.length === 1 ? "" : "s"} applied
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ParamReadout({ params }: { params: ChromakeyParams }) {
  return (
    <div className="p-3 border-b border-border">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 block">
        Current Draft Params
      </Label>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] font-mono">
        <dt className="text-muted-foreground">color</dt>
        <dd className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-sm border border-border shrink-0"
            style={{ backgroundColor: params.color }}
          />
          {params.color.toUpperCase()}
        </dd>
        <dt className="text-muted-foreground">tolerance</dt>
        <dd>{params.tolerance}%</dd>
        <dt className="text-muted-foreground">strategy</dt>
        <dd>{params.strategy === "flood" ? "flood (smart)" : "global"}</dd>
        <dt className="text-muted-foreground">feather</dt>
        <dd>{params.edgeFeather}px</dd>
        <dt className="text-muted-foreground">solid edges</dt>
        <dd>{params.finish.solidEdges ? "✓" : "✗"}</dd>
        <dt className="text-muted-foreground">threshold</dt>
        <dd>{params.finish.alphaThreshold}</dd>
        <dt className="text-muted-foreground">choke</dt>
        <dd>{params.finish.choke}px</dd>
        <dt className="text-muted-foreground">despill</dt>
        <dd>{params.finish.despill ? "✓" : "✗"}</dd>
      </dl>
    </div>
  );
}

function ExplanationLog({
  log,
  onUndo,
}: {
  log: string[];
  onUndo: () => void;
}) {
  return (
    <div className="p-3 flex-1 min-h-0 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Adjustment Log
        </Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className="h-7 px-2"
          title="Undo last adjustment"
        >
          <Undo2 className="h-3.5 w-3.5" /> Undo
        </Button>
      </div>
      <ol className="space-y-1 text-[11px] overflow-y-auto pr-1">
        {log.map((entry, i) => (
          <li
            key={`${i}-${entry}`}
            className={cn(
              "rounded px-2 py-1 leading-snug",
              i === 0
                ? "bg-primary/10 border border-primary/30 text-foreground"
                : "bg-muted/50 text-muted-foreground"
            )}
          >
            {entry}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CritiqueRow({
  onApply,
  disabled,
}: {
  onApply: (id: CritiqueId) => void;
  disabled?: boolean;
}) {
  const groups: { title: string; group: typeof CRITIQUES[number]["group"] }[] = [
    { title: "Amount", group: "amount" },
    { title: "Interior", group: "interior" },
    { title: "Edges", group: "edges" },
    { title: "Color", group: "color" },
  ];
  return (
    <div className="px-4 py-2.5 border-b border-border">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 block">
        What do you see? (click to apply)
      </Label>
      <div className="flex flex-wrap gap-x-3 gap-y-2">
        {groups.map((g) => {
          const items = CRITIQUES.filter((c) => c.group === g.group);
          if (items.length === 0) return null;
          return (
            <div key={g.group} className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-0.5">
                {g.title}
              </span>
              {items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onApply(c.id)}
                  title={c.description}
                  className={cn(
                    "text-[11px] px-2 py-1 rounded border transition-colors cursor-pointer",
                    "border-border bg-card hover:border-primary hover:bg-primary/10",
                    "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-card"
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FreeformInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-2">
      <Label htmlFor="freeform-critique" className="text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">
        Or describe it:
      </Label>
      <input
        id="freeform-critique"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        disabled={disabled}
        placeholder="e.g. white inside the dress got eaten · halo around the flowers · BG still showing in corners"
        className="flex-1 h-8 rounded-md border border-input bg-card px-3 text-xs disabled:opacity-50"
      />
      <Button
        size="sm"
        onClick={onSubmit}
        disabled={disabled || !value.trim()}
      >
        Apply
      </Button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-3">
      <ImagePlus className="h-12 w-12 opacity-30" />
      <div>
        <div className="text-sm font-medium text-foreground">No test image yet</div>
        <p className="text-xs mt-1 max-w-xs">
          Load an invitation design to see how the current draft preset removes its background.
          Then critique the result and the algo adjusts.
        </p>
      </div>
      <Button onClick={onAdd}>
        <ImagePlus className="h-4 w-4" /> Add a test image
      </Button>
    </div>
  );
}

function SavePresetDialog({
  name,
  icon,
  notes,
  aggregatedParams,
  acceptedCount,
  onNameChange,
  onIconChange,
  onNotesChange,
  onConfirm,
  onCancel,
}: {
  name: string;
  icon: string;
  notes: string;
  aggregatedParams: ChromakeyParams | null;
  acceptedCount: number;
  onNameChange: (v: string) => void;
  onIconChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-card rounded-xl shadow-xl border border-border max-w-md w-full mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-1">Save preset</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Averaged from {acceptedCount} good sample
          {acceptedCount === 1 ? "" : "s"}.
        </p>

        <div className="space-y-3">
          <div>
            <Label htmlFor="preset-name">Name</Label>
            <input
              id="preset-name"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="e.g. Acrylic Invite v2"
              className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="preset-icon">Icon (one emoji)</Label>
            <input
              id="preset-icon"
              value={icon}
              onChange={(e) => onIconChange(e.target.value.slice(0, 4))}
              className="mt-1 h-9 w-20 rounded-md border border-input bg-card px-3 text-lg text-center"
            />
          </div>
          <div>
            <Label htmlFor="preset-notes">Notes (optional)</Label>
            <textarea
              id="preset-notes"
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Tooltip shown when hovering this preset"
              rows={2}
              className="mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm resize-none"
            />
          </div>
          {aggregatedParams && (
            <div className="rounded-md bg-muted p-2.5 text-[11px] font-mono space-y-0.5">
              <div className="text-muted-foreground mb-1 font-sans uppercase tracking-wide text-[10px]">
                Final params
              </div>
              <div>color: {aggregatedParams.color.toUpperCase()}</div>
              <div>tolerance: {aggregatedParams.tolerance}%</div>
              <div>strategy: {aggregatedParams.strategy}</div>
              <div>feather: {aggregatedParams.edgeFeather}px</div>
              <div>
                solid edges: {aggregatedParams.finish.solidEdges ? "on" : "off"}{" "}
                · threshold: {aggregatedParams.finish.alphaThreshold} · choke:{" "}
                {aggregatedParams.finish.choke}px
              </div>
              <div>despill: {aggregatedParams.finish.despill ? "on" : "off"}</div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="gradient" onClick={onConfirm}>
            <Save className="h-4 w-4" /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}
