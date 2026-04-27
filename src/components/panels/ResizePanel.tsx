"use client";

import { useEffect, useState } from "react";
import { Loader2, Maximize2, Link as LinkIcon, Unlink, Shirt } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { cn } from "@/lib/utils";

export interface ResizeParams {
  width: number;
  height: number;
  fit: "stretch" | "contain" | "cover";
  dpi: number;
  units: "px" | "in" | "cm";
}

interface ResizePanelProps {
  currentWidth: number;
  currentHeight: number;
  isProcessing: boolean;
  onApply: (params: ResizeParams) => Promise<void> | void;
  disabled?: boolean;
}

interface PrintPreset {
  name: string;
  /** width × height in inches; height of 0 means "auto - keep aspect from width" */
  widthIn: number;
  heightIn: number; // 0 = auto
  fit: "stretch" | "contain";
  description: string;
}

const PRINT_PRESETS: PrintPreset[] = [
  {
    name: "Shirt Front",
    widthIn: 12,
    heightIn: 0,
    fit: "contain",
    description: "12in wide, full chest",
  },
  {
    name: "Shirt Back",
    widthIn: 12,
    heightIn: 16,
    fit: "contain",
    description: "12 × 16in",
  },
  {
    name: "Pocket",
    widthIn: 4,
    heightIn: 4,
    fit: "contain",
    description: "4 × 4in left chest",
  },
  {
    name: "Sticker (S)",
    widthIn: 3,
    heightIn: 3,
    fit: "contain",
    description: "3 × 3in",
  },
  {
    name: "Sticker (L)",
    widthIn: 5,
    heightIn: 5,
    fit: "contain",
    description: "5 × 5in",
  },
  {
    name: "Hat",
    widthIn: 4.5,
    heightIn: 2.25,
    fit: "contain",
    description: "4.5 × 2.25in front panel",
  },
  {
    name: "Mug Wrap",
    widthIn: 8.5,
    heightIn: 3,
    fit: "contain",
    description: "8.5 × 3in",
  },
  {
    name: "A4 Paper",
    widthIn: 8.27,
    heightIn: 11.69,
    fit: "contain",
    description: "Full sheet",
  },
];

export function ResizePanel({
  currentWidth,
  currentHeight,
  isProcessing,
  onApply,
  disabled,
}: ResizePanelProps) {
  const [units, setUnits] = useState<"px" | "in" | "cm">("in");
  const [dpi, setDpi] = useState(300);
  const [width, setWidth] = useState<number>(0);
  const [height, setHeight] = useState<number>(0);
  const [linked, setLinked] = useState(true);
  const [fit, setFit] = useState<"stretch" | "contain" | "cover">("contain");
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Convert pixel dims to current units when units/dpi/source change.
  useEffect(() => {
    setWidth(pxToUnit(currentWidth, units, dpi));
    setHeight(pxToUnit(currentHeight, units, dpi));
  }, [currentWidth, currentHeight, units, dpi]);

  const aspectRatio = currentWidth / currentHeight;

  const setW = (w: number) => {
    setWidth(w);
    setActivePreset(null);
    if (linked) setHeight(round(w / aspectRatio, units));
  };
  const setH = (h: number) => {
    setHeight(h);
    setActivePreset(null);
    if (linked) setWidth(round(h * aspectRatio, units));
  };

  const applyPreset = (p: PrintPreset) => {
    setUnits("in");
    setDpi(300);
    setActivePreset(p.name);
    if (p.heightIn === 0) {
      setLinked(true);
      setWidth(p.widthIn);
      setHeight(round(p.widthIn / aspectRatio, "in"));
      setFit("contain");
    } else {
      setLinked(false);
      setWidth(p.widthIn);
      setHeight(p.heightIn);
      setFit(p.fit);
    }
  };

  const apply = () => {
    const wPx = unitToPx(width, units, dpi);
    const hPx = unitToPx(height, units, dpi);
    onApply({
      width: Math.max(1, Math.round(wPx)),
      height: Math.max(1, Math.round(hPx)),
      fit,
      dpi,
      units,
    });
  };

  return (
    <div className="space-y-5 pt-2">
      {/* Print Presets */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Shirt className="h-3.5 w-3.5 text-primary" />
          <Label className="!text-foreground !text-sm !normal-case !tracking-normal !font-semibold">
            Quick Print Presets
          </Label>
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          One click → exact size at 300 DPI ready for print.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          {PRINT_PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => applyPreset(p)}
              disabled={disabled}
              className={cn(
                "text-left rounded-md border p-2 transition-all cursor-pointer",
                "hover:border-primary/40 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed",
                activePreset === p.name
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border bg-card"
              )}
            >
              <div className="text-xs font-semibold">{p.name}</div>
              <div className="text-[10px] text-muted-foreground">{p.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <Label className="!text-foreground !text-sm !normal-case !tracking-normal !font-semibold mb-2 block">
          Custom Size
        </Label>

        <div className="grid grid-cols-3 gap-1.5 mb-3">
          <UnitButton active={units === "px"} onClick={() => setUnits("px")}>Pixels</UnitButton>
          <UnitButton active={units === "in"} onClick={() => setUnits("in")}>Inches</UnitButton>
          <UnitButton active={units === "cm"} onClick={() => setUnits("cm")}>Cm</UnitButton>
        </div>

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label>Width</Label>
            <Input
              type="number"
              min={0.01}
              step={units === "px" ? 1 : 0.01}
              value={Number.isFinite(width) ? round(width, units) : ""}
              onChange={(e) => setW(parseFloat(e.target.value) || 0)}
              disabled={disabled}
            />
          </div>
          <button
            onClick={() => setLinked(!linked)}
            title={linked ? "Aspect ratio locked" : "Aspect ratio unlocked"}
            className={cn(
              "mb-0.5 h-10 w-10 inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer",
              linked
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted-foreground hover:bg-muted"
            )}
          >
            {linked ? <LinkIcon className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
          </button>
          <div className="flex-1">
            <Label>Height</Label>
            <Input
              type="number"
              min={0.01}
              step={units === "px" ? 1 : 0.01}
              value={Number.isFinite(height) ? round(height, units) : ""}
              onChange={(e) => setH(parseFloat(e.target.value) || 0)}
              disabled={disabled}
            />
          </div>
        </div>

        {units !== "px" && (
          <div className="mt-3">
            <Label>Print Quality (DPI)</Label>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {[150, 300, 600].map((d) => (
                <button
                  key={d}
                  onClick={() => setDpi(d)}
                  className={cn(
                    "h-9 rounded-md border text-xs font-medium transition-colors cursor-pointer",
                    dpi === d
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card hover:bg-muted"
                  )}
                >
                  {d}
                </button>
              ))}
              <Input
                type="number"
                value={dpi}
                onChange={(e) => setDpi(parseInt(e.target.value) || 300)}
                className="h-9"
                disabled={disabled}
              />
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              300 DPI is standard for DTF and most printing. Use 600 for tiny detail.
            </p>
          </div>
        )}

        <div className="mt-3">
          <Label>If size doesn't match the design</Label>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <FitButton active={fit === "contain"} onClick={() => setFit("contain")}>
              Fit
            </FitButton>
            <FitButton active={fit === "stretch"} onClick={() => setFit("stretch")}>
              Stretch
            </FitButton>
            <FitButton active={fit === "cover"} onClick={() => setFit("cover")}>
              Fill
            </FitButton>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {fit === "contain" && "Keep proportions, add transparent padding."}
            {fit === "stretch" && "Force exact size (may distort the design)."}
            {fit === "cover" && "Keep proportions, crop overflow."}
          </p>
        </div>
      </div>

      <div className="rounded-lg bg-muted p-3 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Output pixels:</span>
          <span className="font-mono">
            {Math.round(unitToPx(width, units, dpi))} × {Math.round(unitToPx(height, units, dpi))} px
          </span>
        </div>
        {units !== "px" && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Physical size:</span>
            <span className="font-mono">
              {round(width, units)} × {round(height, units)} {units}
            </span>
          </div>
        )}
      </div>

      <Button
        variant="gradient"
        className="w-full"
        onClick={apply}
        disabled={disabled || isProcessing || width <= 0 || height <= 0}
      >
        {isProcessing ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Resizing…
          </>
        ) : (
          <>
            <Maximize2 className="h-4 w-4" /> Apply Size
          </>
        )}
      </Button>
    </div>
  );
}

function UnitButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-9 rounded-md border text-xs font-medium transition-colors cursor-pointer",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function FitButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-9 rounded-md border text-xs font-medium transition-colors cursor-pointer",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function pxToUnit(px: number, unit: "px" | "in" | "cm", dpi: number): number {
  if (unit === "px") return px;
  if (unit === "in") return px / dpi;
  return (px / dpi) * 2.54;
}
function unitToPx(value: number, unit: "px" | "in" | "cm", dpi: number): number {
  if (unit === "px") return value;
  if (unit === "in") return value * dpi;
  return (value / 2.54) * dpi;
}
function round(v: number, unit: "px" | "in" | "cm"): number {
  if (unit === "px") return Math.round(v);
  return Math.round(v * 100) / 100;
}
