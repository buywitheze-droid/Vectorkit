"use client";

import { useState } from "react";
import { Droplet, Layers, Palette, Square, SunMedium, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Slider } from "@/components/ui/Slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";

export interface DropShadowParams {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  opacity: number;
}

export interface OutlineParams {
  width: number;
  color: string;
}

export interface ColorReplaceParams {
  fromColor: string;
  toColor: string;
  tolerance: number;
  preserveLuma: boolean;
}

export interface EffectsPanelHandlers {
  onDropShadow: (p: DropShadowParams) => void;
  onOutline: (p: OutlineParams) => void;
  onReplaceColor: (p: ColorReplaceParams) => void;
  onGrayscale: () => void;
  onSepia: () => void;
  onInvert: () => void;
  onFlattenBackground: (color: string) => void;
}

interface EffectsPanelProps extends EffectsPanelHandlers {
  isProcessing: boolean;
}

export function EffectsPanel({
  onDropShadow,
  onOutline,
  onReplaceColor,
  onGrayscale,
  onSepia,
  onInvert,
  onFlattenBackground,
  isProcessing,
}: EffectsPanelProps) {
  const [tab, setTab] = useState<"shadow" | "outline" | "recolor" | "filters">(
    "shadow"
  );

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
      <TabsList>
        <TabsTrigger value="shadow">
          <Layers className="h-3.5 w-3.5" /> Shadow
        </TabsTrigger>
        <TabsTrigger value="outline">
          <Square className="h-3.5 w-3.5" /> Outline
        </TabsTrigger>
        <TabsTrigger value="recolor">
          <Palette className="h-3.5 w-3.5" /> Recolor
        </TabsTrigger>
        <TabsTrigger value="filters">
          <SunMedium className="h-3.5 w-3.5" /> Filters
        </TabsTrigger>
      </TabsList>

      <TabsContent value="shadow" className="pt-4">
        <DropShadowControls onApply={onDropShadow} disabled={isProcessing} />
      </TabsContent>
      <TabsContent value="outline" className="pt-4">
        <OutlineControls onApply={onOutline} disabled={isProcessing} />
      </TabsContent>
      <TabsContent value="recolor" className="pt-4">
        <RecolorControls onApply={onReplaceColor} disabled={isProcessing} />
      </TabsContent>
      <TabsContent value="filters" className="pt-4">
        <FiltersControls
          onGrayscale={onGrayscale}
          onSepia={onSepia}
          onInvert={onInvert}
          onFlattenBackground={onFlattenBackground}
          disabled={isProcessing}
        />
      </TabsContent>
    </Tabs>
  );
}

function DropShadowControls({
  onApply,
  disabled,
}: {
  onApply: (p: DropShadowParams) => void;
  disabled: boolean;
}) {
  const [color, setColor] = useState("#000000");
  const [offsetX, setOffsetX] = useState(8);
  const [offsetY, setOffsetY] = useState(8);
  const [blur, setBlur] = useState(12);
  const [opacity, setOpacity] = useState(50);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Adds a soft cast shadow behind your transparent design. The canvas will grow to fit the shadow.
      </p>
      <ColorPickerRow label="Shadow Color" color={color} setColor={setColor} />

      <RangeRow label="Horizontal Offset" value={offsetX} setValue={setOffsetX} min={-50} max={50} suffix="px" />
      <RangeRow label="Vertical Offset" value={offsetY} setValue={setOffsetY} min={-50} max={50} suffix="px" />
      <RangeRow label="Blur" value={blur} setValue={setBlur} min={0} max={60} suffix="px" />
      <RangeRow label="Opacity" value={opacity} setValue={setOpacity} min={0} max={100} suffix="%" />

      <Button
        variant="primary"
        className="w-full"
        disabled={disabled}
        onClick={() =>
          onApply({ color, offsetX, offsetY, blur, opacity: opacity / 100 })
        }
      >
        <Layers className="h-4 w-4" /> Apply Shadow
      </Button>
    </div>
  );
}

function OutlineControls({
  onApply,
  disabled,
}: {
  onApply: (p: OutlineParams) => void;
  disabled: boolean;
}) {
  const [color, setColor] = useState("#ffffff");
  const [width, setWidth] = useState(8);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Adds a colored ring around your design — popular for stickers and bold shirt graphics.
      </p>
      <ColorPickerRow label="Outline Color" color={color} setColor={setColor} />
      <RangeRow label="Thickness" value={width} setValue={setWidth} min={1} max={50} suffix="px" />
      <Button
        variant="primary"
        className="w-full"
        disabled={disabled}
        onClick={() => onApply({ color, width })}
      >
        <Square className="h-4 w-4" /> Apply Outline
      </Button>
    </div>
  );
}

function RecolorControls({
  onApply,
  disabled,
}: {
  onApply: (p: ColorReplaceParams) => void;
  disabled: boolean;
}) {
  const [fromColor, setFromColor] = useState("#ff0000");
  const [toColor, setToColor] = useState("#0066ff");
  const [tolerance, setTolerance] = useState(20);
  const [preserveLuma, setPreserveLuma] = useState(true);

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted-foreground">
        Replace one color with another. Great for changing brand colors or shirt mockup colors.
      </p>
      <ColorPickerRow label="Replace this color" color={fromColor} setColor={setFromColor} />
      <ColorPickerRow label="With this color" color={toColor} setColor={setToColor} />
      <RangeRow label="Match Range" value={tolerance} setValue={setTolerance} min={0} max={100} suffix="%" />
      <label className="flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={preserveLuma}
          onChange={(e) => setPreserveLuma(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">Preserve shading</div>
          <div className="text-[11px] text-muted-foreground leading-snug">
            Keeps shadows and highlights of the original color so it still looks 3D.
          </div>
        </div>
      </label>
      <Button
        variant="primary"
        className="w-full"
        disabled={disabled}
        onClick={() => onApply({ fromColor, toColor, tolerance, preserveLuma })}
      >
        <Palette className="h-4 w-4" /> Replace Color
      </Button>
    </div>
  );
}

function FiltersControls({
  onGrayscale,
  onSepia,
  onInvert,
  onFlattenBackground,
  disabled,
}: {
  onGrayscale: () => void;
  onSepia: () => void;
  onInvert: () => void;
  onFlattenBackground: (color: string) => void;
  disabled: boolean;
}) {
  const [bgColor, setBgColor] = useState("#ffffff");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <Button variant="outline" disabled={disabled} onClick={onGrayscale}>
          <Wand2 className="h-3.5 w-3.5" /> B&amp;W
        </Button>
        <Button variant="outline" disabled={disabled} onClick={onSepia}>
          <Wand2 className="h-3.5 w-3.5" /> Sepia
        </Button>
        <Button variant="outline" disabled={disabled} onClick={onInvert}>
          <Wand2 className="h-3.5 w-3.5" /> Invert
        </Button>
      </div>

      <div className="border-t border-border pt-4">
        <Label>Flatten on Solid Color</Label>
        <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
          Composite the transparent design onto a solid background — useful for JPG export or social posts.
        </p>
        <ColorPickerRow label="" color={bgColor} setColor={setBgColor} />
        <Button
          variant="primary"
          className="w-full mt-2"
          disabled={disabled}
          onClick={() => onFlattenBackground(bgColor)}
        >
          <Droplet className="h-4 w-4" /> Flatten Background
        </Button>
      </div>
    </div>
  );
}

function ColorPickerRow({
  label,
  color,
  setColor,
}: {
  label: string;
  color: string;
  setColor: (v: string) => void;
}) {
  return (
    <div>
      {label && <Label>{label}</Label>}
      <div className={label ? "mt-2 flex items-center gap-2" : "flex items-center gap-2"}>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-11 rounded-md border border-border cursor-pointer bg-transparent"
        />
        <input
          type="text"
          value={color.toUpperCase()}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) setColor(v);
          }}
          className="flex-1 h-9 rounded-md border border-input bg-card px-3 text-sm font-mono"
        />
      </div>
    </div>
  );
}

function RangeRow({
  label,
  value,
  setValue,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  setValue: (v: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label className="text-[11px]">{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <Slider value={value} onChange={setValue} min={min} max={max} />
    </div>
  );
}
