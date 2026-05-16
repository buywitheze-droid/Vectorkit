"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Trash2,
  Type as TypeIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FontPicker } from "@/components/FontPicker";
import { getFont } from "@/lib/fonts/registry";
import {
  COMMON_TEXT_SWATCHES,
  type TextLayer,
  type TextLayerPatch,
} from "@/lib/image/textLayer";
import { cn } from "@/lib/utils";

interface TextLayerInspectorProps {
  layer: TextLayer;
  /** Source-canvas height in px. Used to scale the size slider so it
   *  shows useful values regardless of source resolution (a 50-px
   *  font on a 4500-px canvas is tiny; on a 600-px canvas it's huge). */
  sourceHeight: number;
  onPatch: (patch: TextLayerPatch) => void;
  onDelete: () => void;
  className?: string;
}

/**
 * Inspector for the currently-selected text layer. Edits are dispatched
 * as partial patches via `onPatch` so the parent's reducer stays simple.
 *
 * Layout: dense single-column panel sized to drop into a sidebar
 * (~280px). Controls are grouped by frequency-of-use:
 *
 *   1. Text content (most-edited).
 *   2. Font + weight/italic (second-most).
 *   3. Size + alignment (often).
 *   4. Color + tracking (occasionally).
 *   5. Rotation (rare).
 *   6. Delete (rare but destructive — kept at the bottom + with
 *      confirm-style red colour).
 */
export function TextLayerInspector({
  layer,
  sourceHeight,
  onPatch,
  onDelete,
  className,
}: TextLayerInspectorProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const font = getFont(layer.fontId);

  // Size slider works in "percent of canvas height" so the values feel
  // consistent across different source resolutions.
  const sizePct = (layer.size / sourceHeight) * 100;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        <TypeIcon className="h-3.5 w-3.5" />
        Text properties
      </div>

      {/* ── Text content ──────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground block mb-1">
          Text
        </label>
        <textarea
          value={layer.text}
          onChange={(e) => onPatch({ text: e.target.value })}
          rows={2}
          className="w-full text-sm rounded-md border border-border bg-card px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
          placeholder="Type your text…"
        />
      </div>

      {/* ── Font ──────────────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground block mb-1">
          Font
        </label>
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          className="w-full text-left px-3 py-2 rounded-md border border-border bg-card hover:bg-muted flex items-center justify-between cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className="text-lg leading-none"
              style={{
                fontFamily: font?.family,
                textTransform:
                  font?.category === "display" ? "uppercase" : "none",
              }}
            >
              Aa
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {font?.label ?? layer.fontId}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {font?.vibe}
              </div>
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground ml-2">
            {pickerOpen ? "Close" : "Change"}
          </span>
        </button>

        {pickerOpen && (
          <div className="mt-2 rounded-md border border-border bg-card p-2.5">
            <FontPicker
              value={layer.fontId}
              onChange={(id) => {
                const next = getFont(id);
                if (!next) return;
                // When swapping fonts, clamp weight to one this font
                // actually bundles. Otherwise the inspector would show
                // a weight slider value that silently falls back at
                // render time.
                const weight = next.weights.includes(layer.weight)
                  ? layer.weight
                  : next.weights[0];
                onPatch({ fontId: id, weight, italic: next.hasItalic ? layer.italic : false });
                setPickerOpen(false);
              }}
              sample={layer.text || "Quinceañera"}
            />
          </div>
        )}
      </div>

      {/* ── Weight + style (italic) ───────────────────────────────── */}
      {font && (font.weights.length > 1 || font.hasItalic) && (
        <div className="flex items-center gap-2">
          {font.weights.length > 1 && (
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                Weight
              </label>
              <select
                value={layer.weight}
                onChange={(e) => onPatch({ weight: Number(e.target.value) })}
                className="w-full h-9 rounded-md border border-border bg-card px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer"
              >
                {font.weights.map((w) => (
                  <option key={w} value={w}>
                    {weightLabel(w)} ({w})
                  </option>
                ))}
              </select>
            </div>
          )}
          {font.hasItalic && (
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                Style
              </label>
              <div className="flex gap-1">
                <ToggleButton
                  active={!layer.italic}
                  onClick={() => onPatch({ italic: false })}
                  title="Regular"
                >
                  <Bold className="h-3.5 w-3.5" />
                </ToggleButton>
                <ToggleButton
                  active={layer.italic}
                  onClick={() => onPatch({ italic: true })}
                  title="Italic"
                >
                  <Italic className="h-3.5 w-3.5" />
                </ToggleButton>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Size ──────────────────────────────────────────────────── */}
      <div>
        <div className="flex justify-between items-baseline mb-1">
          <label className="text-[11px] font-medium text-muted-foreground">
            Size
          </label>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {sizePct.toFixed(1)}% · {Math.round(layer.size)} px
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={25}
          step={0.1}
          value={sizePct}
          onChange={(e) =>
            onPatch({ size: (Number(e.target.value) / 100) * sourceHeight })
          }
          className="w-full accent-primary cursor-pointer"
        />
      </div>

      {/* ── Alignment ─────────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground block mb-1">
          Align
        </label>
        <div className="flex gap-1">
          <ToggleButton
            active={layer.align === "left"}
            onClick={() => onPatch({ align: "left" })}
            title="Left"
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </ToggleButton>
          <ToggleButton
            active={layer.align === "center"}
            onClick={() => onPatch({ align: "center" })}
            title="Center"
          >
            <AlignCenter className="h-3.5 w-3.5" />
          </ToggleButton>
          <ToggleButton
            active={layer.align === "right"}
            onClick={() => onPatch({ align: "right" })}
            title="Right"
          >
            <AlignRight className="h-3.5 w-3.5" />
          </ToggleButton>
        </div>
      </div>

      {/* ── Color ─────────────────────────────────────────────────── */}
      <div>
        <label className="text-[11px] font-medium text-muted-foreground block mb-1">
          Color
        </label>
        <div className="grid grid-cols-6 gap-1.5 mb-2">
          {COMMON_TEXT_SWATCHES.map((sw) => (
            <button
              key={sw.hex}
              type="button"
              onClick={() => onPatch({ color: sw.hex })}
              title={sw.label}
              className={cn(
                "w-full aspect-square rounded-md border-2 cursor-pointer transition-all hover:scale-110",
                layer.color.toLowerCase() === sw.hex.toLowerCase()
                  ? "border-primary ring-2 ring-primary/30"
                  : "border-border/40 hover:border-border"
              )}
              style={{ backgroundColor: sw.hex }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={layer.color}
            onChange={(e) => onPatch({ color: e.target.value })}
            className="h-8 w-12 rounded border border-border cursor-pointer"
          />
          <input
            type="text"
            value={layer.color}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onPatch({ color: v });
            }}
            className="flex-1 h-8 rounded-md border border-border bg-card px-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="#b8956a"
          />
        </div>
      </div>

      {/* ── Letter spacing + rotation ─────────────────────────────── */}
      <details className="group" open={layer.letterSpacing !== 0 || layer.rotation !== 0}>
        <summary className="text-[11px] font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors list-none flex items-center gap-1.5">
          <span className="group-open:rotate-90 transition-transform">▸</span>
          Advanced
        </summary>
        <div className="mt-2 flex flex-col gap-3 pl-3.5">
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label className="text-[11px] text-muted-foreground">
                Letter spacing
              </label>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {layer.letterSpacing.toFixed(1)} px
              </span>
            </div>
            <input
              type="range"
              min={-5}
              max={30}
              step={0.5}
              value={layer.letterSpacing}
              onChange={(e) => onPatch({ letterSpacing: Number(e.target.value) })}
              className="w-full accent-primary cursor-pointer"
            />
          </div>
          <div>
            <div className="flex justify-between items-baseline mb-1">
              <label className="text-[11px] text-muted-foreground">
                Rotation
              </label>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {((layer.rotation * 180) / Math.PI).toFixed(1)}&deg;
              </span>
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={(layer.rotation * 180) / Math.PI}
              onChange={(e) =>
                onPatch({ rotation: (Number(e.target.value) * Math.PI) / 180 })
              }
              className="w-full accent-primary cursor-pointer"
            />
          </div>
        </div>
      </details>

      {/* ── Delete ────────────────────────────────────────────────── */}
      <div className="border-t border-border pt-3">
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          className="w-full"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete text layer
        </Button>
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "h-9 w-9 inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-foreground border-border hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

function weightLabel(w: number): string {
  if (w <= 300) return "Light";
  if (w <= 400) return "Regular";
  if (w <= 500) return "Medium";
  if (w <= 600) return "Semi-bold";
  if (w <= 700) return "Bold";
  return "Heavy";
}
