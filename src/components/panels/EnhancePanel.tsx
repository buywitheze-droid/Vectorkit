"use client";

import { useState } from "react";
import { Camera, Loader2, Palette, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Slider } from "@/components/ui/Slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import {
  GRAPHIC_AUTO_PRESET,
  GRAPHIC_NEUTRAL,
  PHOTO_AUTO_PRESET,
  PHOTO_NEUTRAL,
  type GraphicAdjustments,
  type PhotoAdjustments,
} from "@/lib/image/enhance";

interface EnhancePanelProps {
  isProcessing: boolean;
  detectedType: "photo" | "graphic" | "graphic-with-transparency" | null;
  onApplyPhoto: (adj: PhotoAdjustments) => Promise<void> | void;
  onApplyGraphic: (adj: GraphicAdjustments) => Promise<void> | void;
  disabled?: boolean;
}

export function EnhancePanel({
  isProcessing,
  detectedType,
  onApplyPhoto,
  onApplyGraphic,
  disabled,
}: EnhancePanelProps) {
  const initialTab = detectedType === "photo" ? "photo" : "graphic";
  const [tab, setTab] = useState<"photo" | "graphic">(initialTab);

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "photo" | "graphic")}>
      <TabsList>
        <TabsTrigger value="photo">
          <Camera className="h-3.5 w-3.5" /> Photo
        </TabsTrigger>
        <TabsTrigger value="graphic">
          <Palette className="h-3.5 w-3.5" /> Logo / Graphic
        </TabsTrigger>
      </TabsList>

      <TabsContent value="photo" className="pt-4">
        <PhotoControls
          isProcessing={isProcessing}
          onApply={onApplyPhoto}
          disabled={disabled}
        />
      </TabsContent>

      <TabsContent value="graphic" className="pt-4">
        <GraphicControls
          isProcessing={isProcessing}
          onApply={onApplyGraphic}
          disabled={disabled}
        />
      </TabsContent>
    </Tabs>
  );
}

// ─── Photo controls ─────────────────────────────────────────────────────────

function PhotoControls({
  isProcessing,
  onApply,
  disabled,
}: {
  isProcessing: boolean;
  onApply: (adj: PhotoAdjustments) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [adj, setAdj] = useState<PhotoAdjustments>(PHOTO_NEUTRAL);
  const update = (key: keyof PhotoAdjustments, value: number | boolean) =>
    setAdj((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
        <p className="text-xs text-foreground mb-2 font-medium flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Not sure what to tweak?
        </p>
        <Button
          variant="gradient"
          className="w-full"
          onClick={() => onApply(PHOTO_AUTO_PRESET)}
          disabled={disabled || isProcessing}
        >
          {isProcessing ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Enhancing…</>
          ) : (
            <><Wand2 className="h-4 w-4" /> One-Click Auto Enhance</>
          )}
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
          Brightens shadows, balances colors, sharpens detail — perfect for phone photos.
        </p>
      </div>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1.5 select-none">
          <span className="group-open:rotate-90 transition-transform">▸</span>
          Fine-tune manually
        </summary>

        <div className="space-y-4 mt-3 pl-3 border-l border-border">
          <PercentSlider
            label="Brightness"
            help="Make the whole image lighter or darker"
            value={adj.brightness}
            onChange={(v) => update("brightness", v)}
          />
          <PercentSlider
            label="Contrast"
            help="Make light areas brighter and dark areas darker"
            value={adj.contrast}
            onChange={(v) => update("contrast", v)}
          />
          <PercentSlider
            label="Saturation"
            help="Make colors more or less vivid"
            value={adj.saturation}
            onChange={(v) => update("saturation", v)}
          />
          <PercentSlider
            label="Color Pop (Vibrance)"
            help="Smart saturation that protects skin tones"
            value={adj.vibrance}
            onChange={(v) => update("vibrance", v)}
          />
          <PercentSlider
            label="Lift Shadows"
            help="Recover detail from dark areas"
            value={adj.shadows}
            onChange={(v) => update("shadows", v)}
          />
          <PercentSlider
            label="Recover Highlights"
            help="Pull back blown-out bright areas"
            value={adj.highlights}
            onChange={(v) => update("highlights", v)}
          />
          <PercentSlider
            label="Warmth"
            help="Cooler (blue) ⇄ Warmer (orange)"
            value={adj.warmth}
            onChange={(v) => update("warmth", v)}
          />
          <PositiveSlider
            label="Sharpness"
            help="Make edges crisper"
            value={adj.sharpen}
            onChange={(v) => update("sharpen", v)}
            max={100}
          />
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={adj.autoLevels}
              onChange={(e) => update("autoLevels", e.target.checked)}
              className="h-4 w-4 rounded border-border accent-[var(--primary)]"
            />
            <span>Auto color balance</span>
          </label>
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => onApply(adj)}
            disabled={disabled || isProcessing}
          >
            Apply Adjustments
          </Button>
          <Button
            variant="ghost"
            onClick={() => setAdj(PHOTO_NEUTRAL)}
            disabled={disabled || isProcessing}
          >
            Reset Sliders
          </Button>
        </div>
      </details>
    </div>
  );
}

// ─── Graphic controls ───────────────────────────────────────────────────────

function GraphicControls({
  isProcessing,
  onApply,
  disabled,
}: {
  isProcessing: boolean;
  onApply: (adj: GraphicAdjustments) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [adj, setAdj] = useState<GraphicAdjustments>(GRAPHIC_NEUTRAL);
  const update = (key: keyof GraphicAdjustments, value: number) =>
    setAdj((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
        <p className="text-xs text-foreground mb-2 font-medium flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Make designs print bolder
        </p>
        <Button
          variant="gradient"
          className="w-full"
          onClick={() => onApply(GRAPHIC_AUTO_PRESET)}
          disabled={disabled || isProcessing}
        >
          {isProcessing ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Enhancing…</>
          ) : (
            <><Wand2 className="h-4 w-4" /> One-Click Punch Up</>
          )}
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground leading-snug">
          Boosts contrast and color, sharpens edges, cleans up transparent fringes — ideal for DTF.
        </p>
      </div>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1.5 select-none">
          <span className="group-open:rotate-90 transition-transform">▸</span>
          Fine-tune manually
        </summary>

        <div className="space-y-4 mt-3 pl-3 border-l border-border">
          <PercentSlider
            label="Contrast"
            help="Make light areas brighter and dark areas darker"
            value={adj.contrast}
            onChange={(v) => update("contrast", v)}
          />
          <PercentSlider
            label="Color Pop"
            help="Make solid colors more vivid"
            value={adj.vibrance}
            onChange={(v) => update("vibrance", v)}
          />
          <PositiveSlider
            label="Edge Sharpness"
            help="Crisp up logo edges"
            value={adj.sharpen}
            onChange={(v) => update("sharpen", v)}
            max={100}
          />
          <PositiveSlider
            label="Edge Cleanup"
            help="Tighten transparent edges (better for cutouts and DTF)"
            value={adj.edgeCleanup}
            onChange={(v) => update("edgeCleanup", v)}
            max={100}
          />
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => onApply(adj)}
            disabled={disabled || isProcessing}
          >
            Apply Adjustments
          </Button>
          <Button
            variant="ghost"
            onClick={() => setAdj(GRAPHIC_NEUTRAL)}
            disabled={disabled || isProcessing}
          >
            Reset Sliders
          </Button>
        </div>
      </details>
    </div>
  );
}

// ─── Reusable slider rows ───────────────────────────────────────────────────

function PercentSlider({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {value > 0 ? "+" : ""}
          {value}
        </span>
      </div>
      <Slider value={value} onChange={onChange} min={-100} max={100} />
      {help && <p className="mt-1 text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}

function PositiveSlider({
  label,
  help,
  value,
  onChange,
  max = 100,
}: {
  label: string;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{value}</span>
      </div>
      <Slider value={value} onChange={onChange} min={0} max={max} />
      {help && <p className="mt-1 text-[11px] text-muted-foreground">{help}</p>}
    </div>
  );
}
