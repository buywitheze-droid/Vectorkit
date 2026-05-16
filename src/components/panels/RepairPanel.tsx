"use client";

import { useEffect, useState } from "react";
import { LifeBuoy, Loader2, Pipette } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Slider } from "@/components/ui/Slider";
import { cn } from "@/lib/utils";
import {
  REPAIR_PROFILES,
  type RepairProfile,
  type RestoreColorOptions,
  type RestoreMode,
} from "@/lib/image/restore";

export interface RepairParams extends RestoreColorOptions {}

interface RepairPanelProps {
  onApply: (params: RepairParams) => Promise<void> | void;
  onPickColorMode: (active: boolean) => void;
  pickedColor: string | null;
  isProcessing: boolean;
  /** True when there's an "original" canvas to restore from (history.length > 0). */
  hasOriginal: boolean;
}

export function RepairPanel({
  onApply,
  onPickColorMode,
  pickedColor,
  isProcessing,
  hasOriginal,
}: RepairPanelProps) {
  const [color, setColor] = useState("#ff8fb3"); // pinkish default for invitations
  const [tolerance, setTolerance] = useState(22);
  const [padding, setPadding] = useState(1);
  const [searchRadius, setSearchRadius] = useState(40);
  const [mode, setMode] = useState<RestoreMode>("original");
  const [activeProfile, setActiveProfile] = useState<string>("light-dress");
  const [picking, setPicking] = useState(false);

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

  const applyProfile = (profile: RepairProfile) => {
    setActiveProfile(profile.id);
    setTolerance(profile.defaults.tolerance);
    setPadding(profile.defaults.padding);
    setSearchRadius(profile.defaults.searchRadius);
    setMode(profile.defaults.mode);
  };

  const handleApply = () => {
    onApply({ color, tolerance, padding, searchRadius, mode });
  };

  if (!hasOriginal) {
    return (
      <div className="pt-2 text-sm text-muted-foreground">
        Load an image first.
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-start gap-2">
          <LifeBuoy className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[12px] leading-snug">
            <strong>Background remover ate part of your design?</strong> Pick
            the color that got eaten and bring it back from the original. Use
            multiple times for different colors (text, flowers, dress, crown).
          </div>
        </div>
      </div>

      {/* Profiles */}
      <div>
        <Label>What got eaten?</Label>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {REPAIR_PROFILES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyProfile(p)}
              title={p.description}
              className={cn(
                "text-left rounded-md border p-2 transition-all cursor-pointer",
                activeProfile === p.id
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border bg-card hover:border-primary/40"
              )}
            >
              <div className="text-xs font-medium leading-tight">{p.name}</div>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">
          {REPAIR_PROFILES.find((p) => p.id === activeProfile)?.description}
        </p>
      </div>

      {/* Color */}
      <div>
        <Label>Color to restore</Label>
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
            title="Pick color from the visible part of your design"
          >
            <Pipette className="h-4 w-4" />
          </Button>
        </div>
        {picking && (
          <p className="mt-1.5 text-[11px] text-primary font-medium">
            👉 Click on a clean spot of the color you want to restore (e.g. center of a letter, intact flower petal, dress middle)
          </p>
        )}
      </div>

      {/* Mode */}
      <div>
        <Label>How to restore</Label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <ModeCard
            active={mode === "solid"}
            onClick={() => setMode("solid")}
            title="Solid color"
            description="Every restored pixel becomes the exact picked color. Perfect for letters — gives crisp, uniform text with no halos."
          />
          <ModeCard
            active={mode === "original"}
            onClick={() => setMode("original")}
            title="Original colors"
            description="Restored pixels keep their natural RGB. Best for flowers, dresses, gradients — preserves shading."
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Color match range</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {tolerance}%
          </span>
        </div>
        <Slider value={tolerance} onChange={setTolerance} min={0} max={50} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          How loose the color match is — higher catches more shades.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Edge padding</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {padding}px
          </span>
        </div>
        <Slider value={padding} onChange={setPadding} min={0} max={5} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Restores a few extra pixels around each match — recovers anti-aliased edge pixels.
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label>Search radius near design</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {searchRadius === 0 ? "no limit" : `${searchRadius}px`}
          </span>
        </div>
        <Slider value={searchRadius} onChange={setSearchRadius} min={0} max={200} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Only restore pixels within this distance of the surviving design — prevents the entire background from coming back. Set to 0 only if a whole element was wiped out.
        </p>
      </div>

      <Button
        variant="gradient"
        className="w-full"
        disabled={isProcessing}
        onClick={handleApply}
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Restoring…
          </>
        ) : (
          <>
            <LifeBuoy className="h-4 w-4" /> Restore Color
          </>
        )}
      </Button>

      <p className="text-[11px] text-muted-foreground leading-snug border-t border-border pt-3">
        💡 <strong>Tip:</strong> apply once per color. For an invitation, that&apos;s
        usually 4 passes: text → flowers → dress → crown.
      </p>
    </div>
  );
}

function ModeCard({
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
      type="button"
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border p-3 transition-all cursor-pointer",
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary"
          : "border-border bg-card hover:border-primary/40"
      )}
    >
      <div className="text-sm font-medium mb-1">{title}</div>
      <div className="text-[11px] text-muted-foreground leading-snug">
        {description}
      </div>
    </button>
  );
}
