"use client";

import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import {
  FONT_REGISTRY,
  getFont,
  type FontCategory,
  type FontEntry,
} from "@/lib/fonts/registry";
import { cn } from "@/lib/utils";

interface FontPickerProps {
  /** Currently selected font id. */
  value: string;
  onChange: (fontId: string) => void;
  /** Sample text shown in each preview. Defaults to a name-like string
   *  so the user can see how the font handles capitals + descenders. */
  sample?: string;
  /** Optional pixel size to render previews at. Larger = easier to
   *  judge script fonts. */
  previewSize?: number;
  className?: string;
}

const CATEGORY_ORDER: { key: FontCategory; label: string; tagline: string }[] = [
  {
    key: "script",
    label: "Script & calligraphy",
    tagline: "For the hero name and \u201cQuince A\u00f1os\u201d line",
  },
  {
    key: "display",
    label: "Display caps",
    tagline: "For \u201cQUINCEA\u00d1ERA\u201d, \u201cSABADO 15 NOVIEMBRE\u201d",
  },
  {
    key: "body",
    label: "Body text",
    tagline: "Addresses, dates, \u201cPlease join us\u2026\u201d",
  },
];

/**
 * Categorised font picker with live previews. Rendering each preview
 * uses the font's actual family — same as what gets drawn on canvas —
 * so what you see is what you'll print.
 */
export function FontPicker({
  value,
  onChange,
  sample = "Quinceañera",
  previewSize = 28,
  className,
}: FontPickerProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return FONT_REGISTRY;
    return FONT_REGISTRY.filter(
      (f) =>
        f.label.toLowerCase().includes(q) ||
        f.vibe.toLowerCase().includes(q) ||
        f.category.includes(q)
    );
  }, [query]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Search box — useful once you know the curated names. */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search fonts (Allura, body, sage…)"
          className="w-full h-9 pl-8 pr-3 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-4 max-h-[420px] overflow-y-auto pr-1 -mr-1">
        {CATEGORY_ORDER.map((cat) => {
          const fonts = filtered.filter((f) => f.category === cat.key);
          if (fonts.length === 0) return null;
          return (
            <div key={cat.key}>
              <div className="sticky top-0 z-10 bg-card pb-1.5 mb-1.5 border-b border-border/50">
                <h4 className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                  {cat.label}
                </h4>
                <p className="text-[10px] text-muted-foreground/70">
                  {cat.tagline}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                {fonts.map((font) => (
                  <FontRow
                    key={font.id}
                    font={font}
                    selected={font.id === value}
                    sample={sample}
                    previewSize={previewSize}
                    onSelect={() => onChange(font.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground py-6 text-center">
            No fonts match &ldquo;{query}&rdquo;.
          </p>
        )}
      </div>
    </div>
  );
}

function FontRow({
  font,
  selected,
  sample,
  previewSize,
  onSelect,
}: {
  font: FontEntry;
  selected: boolean;
  sample: string;
  previewSize: number;
  onSelect: () => void;
}) {
  // Cap the preview size by category so super-tall scripts don't push
  // the row to obscene heights.
  const size =
    font.category === "script"
      ? Math.min(previewSize * 1.3, 36)
      : font.category === "display"
        ? Math.min(previewSize, 28)
        : Math.min(previewSize * 0.85, 22);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full text-left px-3 py-2 rounded-md transition-colors flex items-center gap-3 group cursor-pointer",
        selected
          ? "bg-primary/10 ring-1 ring-primary/30"
          : "hover:bg-muted"
      )}
    >
      <div className="flex-1 min-w-0">
        <div
          className="leading-tight text-foreground truncate"
          style={{
            fontFamily: font.family,
            fontSize: size,
            // Display caps only look right when actually uppercase.
            textTransform: font.category === "display" ? "uppercase" : "none",
            // Slightly track-out the display caps to match the look.
            letterSpacing: font.category === "display" ? "0.08em" : "normal",
          }}
        >
          {sample}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
          <span className="font-medium">{font.label}</span>
          <span className="opacity-60">·</span>
          <span className="truncate">{font.vibe}</span>
        </div>
      </div>
      {selected && (
        <Check className="h-4 w-4 text-primary flex-shrink-0" />
      )}
    </button>
  );
}

/**
 * Compact label+chip showing the currently-selected font. Used as the
 * trigger for a popover / dialog version of the picker.
 */
export function FontChip({ fontId, className }: { fontId: string; className?: string }) {
  const font = getFont(fontId);
  if (!font) return null;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className="text-base leading-none"
        style={{
          fontFamily: font.family,
          textTransform: font.category === "display" ? "uppercase" : "none",
        }}
      >
        Aa
      </span>
      <span className="text-xs text-foreground truncate">{font.label}</span>
    </div>
  );
}
