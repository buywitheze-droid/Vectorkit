"use client";

import { useState } from "react";
import {
  FlipHorizontal2,
  FlipVertical2,
  Loader2,
  RotateCw,
  Scissors,
  Shield,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Slider } from "@/components/ui/Slider";

export interface TransformPanelHandlers {
  onMirrorH: () => void;
  onMirrorV: () => void;
  onRotate: (degrees: number) => void;
  onAutoCrop: () => void;
  onApplyAlphaThreshold: (threshold: number, choke: number) => void;
}

interface TransformPanelProps extends TransformPanelHandlers {
  isProcessing: boolean;
}

export function TransformPanel({
  onMirrorH,
  onMirrorV,
  onRotate,
  onAutoCrop,
  onApplyAlphaThreshold,
  isProcessing,
}: TransformPanelProps) {
  const [customAngle, setCustomAngle] = useState(0);
  const [threshold, setThreshold] = useState(128);
  const [choke, setChoke] = useState(1);

  return (
    <div className="space-y-5 pt-2">
      {/* ─── Mirror ─── */}
      <div>
        <Label>Mirror / Flip</Label>
        <p className="mb-2 text-[11px] text-muted-foreground leading-snug">
          DTF transfers print face-down — mirror your design before printing so it reads correctly on the shirt.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={isProcessing}
            onClick={onMirrorH}
            className="justify-start"
          >
            <FlipHorizontal2 className="h-4 w-4" />
            Mirror Horizontal
          </Button>
          <Button
            variant="outline"
            disabled={isProcessing}
            onClick={onMirrorV}
            className="justify-start"
          >
            <FlipVertical2 className="h-4 w-4" />
            Mirror Vertical
          </Button>
        </div>
      </div>

      {/* ─── Rotate ─── */}
      <div>
        <Label>Rotate</Label>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[90, 180, 270].map((deg) => (
            <Button
              key={deg}
              variant="outline"
              disabled={isProcessing}
              onClick={() => onRotate(deg)}
            >
              {deg}°
            </Button>
          ))}
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Custom angle</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {customAngle}°
            </span>
          </div>
          <Slider
            value={customAngle}
            onChange={setCustomAngle}
            min={-180}
            max={180}
          />
          <Button
            variant="primary"
            size="sm"
            className="mt-2 w-full"
            disabled={isProcessing || customAngle === 0}
            onClick={() => onRotate(customAngle)}
          >
            <RotateCw className="h-4 w-4" />
            Rotate {customAngle}°
          </Button>
        </div>
      </div>

      {/* ─── Auto-crop ─── */}
      <div className="border-t border-border pt-4">
        <Label>Auto-Crop Transparent Edges</Label>
        <p className="mt-1 text-[11px] text-muted-foreground leading-snug">
          Trims away fully-transparent borders so the design fills the canvas.
        </p>
        <Button
          variant="outline"
          className="mt-2 w-full"
          disabled={isProcessing}
          onClick={onAutoCrop}
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Cropping…
            </>
          ) : (
            <>
              <Scissors className="h-4 w-4" /> Auto-Crop
            </>
          )}
        </Button>
      </div>

      {/* ─── Alpha threshold ─── */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-4 w-4 text-primary" />
          <Label className="m-0">Solid Edges (Alpha Threshold)</Label>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Forces every pixel to be fully opaque or fully transparent — eliminates halos and gives crisp DTF prints. Apply this after BG removal or after resize to re-harden edges.
        </p>

        <div className="mt-3">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Threshold</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {threshold}
            </span>
          </div>
          <Slider value={threshold} onChange={setThreshold} min={1} max={254} />
        </div>

        <div className="mt-3">
          <div className="flex items-center justify-between">
            <Label className="text-[11px]">Edge Choke</Label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {choke}px
            </span>
          </div>
          <Slider value={choke} onChange={setChoke} min={0} max={5} />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Erodes the alpha by N pixels first to remove the soft anti-aliased halo.
          </p>
        </div>

        <Button
          variant="primary"
          className="mt-3 w-full"
          disabled={isProcessing}
          onClick={() => onApplyAlphaThreshold(threshold, choke)}
        >
          <Shield className="h-4 w-4" /> Apply Solid Edges
        </Button>
      </div>
    </div>
  );
}
