"use client";

import { cn } from "@/lib/utils";
import type { BackgroundMode } from "./CanvasViewer";

interface BackgroundSelectorProps {
  value: BackgroundMode;
  onChange: (v: BackgroundMode) => void;
}

const SWATCHES: { value: BackgroundMode; label: string; preview: string }[] = [
  { value: "transparent", label: "Transparent", preview: "checker" },
  { value: "white", label: "White", preview: "#ffffff" },
  { value: "black", label: "Black", preview: "#0a0a0a" },
  { value: "navy", label: "Navy", preview: "#0a3d62" },
  { value: "red", label: "Red", preview: "#8b0000" },
];

export function BackgroundSelector({ value, onChange }: BackgroundSelectorProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-medium text-muted-foreground mr-1">Preview on:</span>
      {SWATCHES.map((s) => (
        <button
          key={s.value}
          onClick={() => onChange(s.value)}
          title={s.label}
          className={cn(
            "h-7 w-7 rounded-md border transition-all cursor-pointer",
            "hover:scale-110 hover:shadow-md",
            value === s.value
              ? "ring-2 ring-primary ring-offset-2 border-primary"
              : "border-border"
          )}
          style={
            s.preview === "checker"
              ? undefined
              : { backgroundColor: s.preview }
          }
        >
          {s.preview === "checker" && (
            <div className="h-full w-full rounded-[5px] checkerboard" />
          )}
        </button>
      ))}
    </div>
  );
}
