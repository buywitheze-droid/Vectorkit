"use client";

import { useEffect, useState } from "react";
import { Loader2, Pipette, Shield, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Slider } from "@/components/ui/Slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { rgbToHex } from "@/lib/image/canvas";
import { cn } from "@/lib/utils";

export interface DtfFinishOptions {
  /** Snap edge alpha to 0 or 255 so every printed pixel is fully opaque. */
  solidEdges: boolean;
  /** Alpha threshold cutoff (1..254). */
  alphaThreshold: number;
  /** Erode alpha by N pixels before threshold to remove halos. */
  choke: number;
  /** Reduce green/blue/red spill on edge pixels left by chromakey. */
  despill: boolean;
}

export interface ChromakeyParams {
  color: string;
  tolerance: number;
  strategy: "global" | "flood";
  edgeFeather: number;
  finish: DtfFinishOptions;
}

export interface AiParams {
  quality: "fast" | "high";
  finish: DtfFinishOptions;
}

interface BgRemovalPanelProps {
  onApplyChromakey: (params: ChromakeyParams) => Promise<void> | void;
  onApplyAi: (params: AiParams) => Promise<void> | void;
  onPickColorMode: (active: boolean) => void;
  pickedColor: string | null;
  isProcessing: boolean;
  aiProgress: { stage: string; pct: number } | null;
  disabled?: boolean;
}

const COLOR_PRESETS = [
  { name: "White", value: "#ffffff" },
  { name: "Black", value: "#000000" },
  { name: "Green Screen", value: "#00b140" },
  { name: "Blue Screen", value: "#0047ab" },
];

export function BgRemovalPanel({
  onApplyChromakey,
  onApplyAi,
  onPickColorMode,
  pickedColor,
  isProcessing,
  aiProgress,
  disabled,
}: BgRemovalPanelProps) {
  const [tab, setTab] = useState<"color" | "ai">("color");
  const [color, setColor] = useState("#ffffff");
  const [tolerance, setTolerance] = useState(8);
  const [strategy, setStrategy] = useState<"global" | "flood">("flood");
  const [edgeFeather, setEdgeFeather] = useState(1);
  const [picking, setPicking] = useState(false);

  // DTF finishing — defaults ON because most users print, and solid edges
  // are non-negotiable for clean DTF transfers.
  const [solidEdges, setSolidEdges] = useState(true);
  const [alphaThreshold, setAlphaThreshold] = useState(128);
  const [choke, setChoke] = useState(1);
  const [despill, setDespill] = useState(true);

  const finish: DtfFinishOptions = {
    solidEdges,
    alphaThreshold,
    choke,
    despill,
  };

  useEffect(() => {
    if (pickedColor) {
      setColor(pickedColor);
      setPicking(false);
      onPickColorMode(false);
    }
  }, [pickedColor, onPickColorMode]);

  const togglePicker = () => {
    const next = !picking;
    setPicking(next);
    onPickColorMode(next);
  };

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "color" | "ai")}>
      <TabsList>
        <TabsTrigger value="color">
          <Wand2 className="h-3.5 w-3.5" />
          By Color
        </TabsTrigger>
        <TabsTrigger value="ai">
          <Sparkles className="h-3.5 w-3.5" />
          AI Smart
        </TabsTrigger>
      </TabsList>

      <TabsContent value="color" className="space-y-4 pt-4">
        <div>
          <Label>Background Color</Label>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-12 rounded-md border border-border cursor-pointer bg-transparent"
            />
            <input
              type="text"
              value={color.toUpperCase()}
              onChange={(e) => {
                const v = e.target.value;
                if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setColor(v);
              }}
              className="flex-1 h-10 rounded-md border border-input bg-card px-3 text-sm font-mono"
            />
            <Button
              type="button"
              variant={picking ? "primary" : "outline"}
              size="icon"
              onClick={togglePicker}
              title="Click to pick a color from your image"
              disabled={disabled}
            >
              <Pipette className="h-4 w-4" />
            </Button>
          </div>
          {picking && (
            <p className="mt-1.5 text-[11px] text-primary font-medium">
              👉 Click anywhere on your image to pick that color
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {COLOR_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setColor(p.value)}
                className="text-[11px] px-2 py-1 rounded border border-border hover:bg-muted transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm border border-border"
                  style={{ backgroundColor: p.value }}
                />
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>Sensitivity</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{tolerance}%</span>
          </div>
          <Slider value={tolerance} onChange={setTolerance} min={0} max={50} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Low = only the exact color · High = also similar shades
          </p>
        </div>

        <div>
          <Label>How to remove</Label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <StrategyCard
              active={strategy === "flood"}
              onClick={() => setStrategy("flood")}
              title="Smart"
              description="Only removes background — keeps matching colors inside your design (recommended)."
            />
            <StrategyCard
              active={strategy === "global"}
              onClick={() => setStrategy("global")}
              title="Everywhere"
              description="Removes every matching pixel, including inside the design."
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label>Edge Smoothness</Label>
            <span className="text-xs text-muted-foreground tabular-nums">{edgeFeather}px</span>
          </div>
          <Slider value={edgeFeather} onChange={setEdgeFeather} min={0} max={5} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Softens the cutout edges — keep low for crisp DTF prints.
          </p>
        </div>

        <DtfFinishControls
          solidEdges={solidEdges}
          setSolidEdges={setSolidEdges}
          alphaThreshold={alphaThreshold}
          setAlphaThreshold={setAlphaThreshold}
          choke={choke}
          setChoke={setChoke}
          despill={despill}
          setDespill={setDespill}
          showDespill
        />

        <Button
          variant="gradient"
          className="w-full"
          disabled={disabled || isProcessing}
          onClick={() =>
            onApplyChromakey({ color, tolerance, strategy, edgeFeather, finish })
          }
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Removing background…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" /> Remove Background
            </>
          )}
        </Button>
      </TabsContent>

      <TabsContent value="ai" className="space-y-4 pt-4">
        <p className="text-sm text-muted-foreground">
          Uses an AI model to detect the subject automatically. Best for photos and complex backgrounds. The first run downloads the model (one-time).
        </p>

        <DtfFinishControls
          solidEdges={solidEdges}
          setSolidEdges={setSolidEdges}
          alphaThreshold={alphaThreshold}
          setAlphaThreshold={setAlphaThreshold}
          choke={choke}
          setChoke={setChoke}
          despill={despill}
          setDespill={setDespill}
        />

        <div className="grid grid-cols-2 gap-3">
          <ModelCard
            title="Fast"
            description="~80 MB model. Loads quickly. Great for logos and clear subjects."
            onClick={() => onApplyAi({ quality: "fast", finish })}
            disabled={disabled || isProcessing}
          />
          <ModelCard
            title="High Quality"
            description="~180 MB model. Slower but cleaner edges, better hair/fur."
            onClick={() => onApplyAi({ quality: "high", finish })}
            disabled={disabled || isProcessing}
            featured
          />
        </div>

        {isProcessing && aiProgress && (
          <div className="rounded-lg bg-muted p-3 text-sm">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="font-medium">{aiProgress.stage}</span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {Math.round(aiProgress.pct)}%
              </span>
            </div>
            <div className="h-2 bg-card rounded-full overflow-hidden">
              <div
                className="h-full brand-gradient transition-all"
                style={{ width: `${aiProgress.pct}%` }}
              />
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

function StrategyCard({
  active,
  onClick,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border p-3 transition-all cursor-pointer",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border bg-card hover:border-primary/40"
      )}
    >
      <div className="text-sm font-medium mb-1">{title}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">{description}</div>
    </button>
  );
}

function ModelCard({
  title,
  description,
  onClick,
  disabled,
  featured,
}: {
  title: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
  featured?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "text-left rounded-lg border p-3 transition-all cursor-pointer",
        "hover:border-primary/40 hover:shadow-sm disabled:opacity-50 disabled:cursor-not-allowed",
        featured ? "border-primary/40 bg-primary/5" : "border-border bg-card"
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-medium">{title}</div>
        {featured && (
          <span className="text-[9px] uppercase font-bold tracking-wide text-primary">
            Recommended
          </span>
        )}
      </div>
      <div className="text-[11px] text-muted-foreground leading-snug">{description}</div>
    </button>
  );
}

function DtfFinishControls({
  solidEdges,
  setSolidEdges,
  alphaThreshold,
  setAlphaThreshold,
  choke,
  setChoke,
  despill,
  setDespill,
  showDespill,
}: {
  solidEdges: boolean;
  setSolidEdges: (v: boolean) => void;
  alphaThreshold: number;
  setAlphaThreshold: (v: number) => void;
  choke: number;
  setChoke: (v: number) => void;
  despill: boolean;
  setDespill: (v: boolean) => void;
  showDespill?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <Shield className="h-3.5 w-3.5 text-primary" />
        DTF Print Finishing
      </div>

      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={solidEdges}
          onChange={(e) => setSolidEdges(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">Solid edges (recommended)</div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            Snaps every pixel to fully opaque or fully transparent — no halos, crisp DTF print.
          </div>
        </div>
      </label>

      {solidEdges && (
        <div className="space-y-3 pl-6">
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">Threshold</Label>
              <span className="text-[10px] text-muted-foreground tabular-nums">{alphaThreshold}</span>
            </div>
            <Slider value={alphaThreshold} onChange={setAlphaThreshold} min={1} max={254} />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Lower = keep more pixels · Higher = stricter cutout
            </p>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-[11px]">Edge Choke</Label>
              <span className="text-[10px] text-muted-foreground tabular-nums">{choke}px</span>
            </div>
            <Slider value={choke} onChange={setChoke} min={0} max={5} />
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Trims a few pixels off the cutout edge to remove leftover halos.
            </p>
          </div>
        </div>
      )}

      {showDespill && (
        <label className="flex items-start gap-2 cursor-pointer select-none border-t border-border pt-3">
          <input
            type="checkbox"
            checked={despill}
            onChange={(e) => setDespill(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">Auto-despill</div>
            <div className="text-[11px] text-muted-foreground leading-snug">
              Removes leftover green/blue/red tint on edges (great for screen-color removal).
            </div>
          </div>
        </label>
      )}
    </div>
  );
}

// Re-export for the picker callback wiring
export { rgbToHex };
