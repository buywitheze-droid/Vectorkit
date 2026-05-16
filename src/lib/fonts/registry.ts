/**
 * Curated font library for the text-overlay tool.
 *
 * The selection is based on direct visual analysis of the user's
 * `B:\Downloads\Shapes` invitation screenshots. Every font in the set
 * matches a specific role observed in those designs:
 *
 *   • SCRIPT — the hero name / "Quince Años" calligraphy.
 *     Many of the invites use Allura/Pinyon/Italianno-style copperplate
 *     scripts. We bundle the closest free Google equivalents.
 *
 *   • DISPLAY — the all-caps display lines like "QUINCEAÑERA",
 *     "SABADO 15 NOVIEMBRE", "PLEASE JOIN US FOR THE QUINCEAÑERA".
 *     These are Trajan-style Roman caps with refined serifs. Cinzel and
 *     family are the canonical free substitutes for Trajan Pro.
 *
 *   • BODY — addresses, "Misa: 1:00pm", "RSVP TO MONICA", etc. Either
 *     elegant serifs (Cormorant Garamond, EB Garamond) or clean
 *     condensed sans (Montserrat, Lato).
 *
 * All fonts are loaded via `next/font/google` so they self-host with
 * the bundle (no external requests at runtime, deterministic loads,
 * works offline). Using `display: "swap"` because invitation editing
 * is interactive — we'd rather show fallback text instantly than block
 * the canvas waiting for a 100KB script font.
 *
 * Each font's `style.fontFamily` is the actual CSS family string
 * (something like `"__Allura_a1b2c3"`) which we use both for HTML
 * preview elements AND for canvas `ctx.font` strings — guaranteeing
 * the live preview and the printed PNG render with the exact same
 * letterforms.
 */

import {
  Allura,
  Alex_Brush,
  Cardo,
  Cinzel,
  Cinzel_Decorative,
  Cormorant_Garamond,
  Crimson_Text,
  Dancing_Script,
  EB_Garamond,
  Great_Vibes,
  Italianno,
  Lato,
  Montserrat,
  Pacifico,
  Parisienne,
  Petit_Formal_Script,
  Pinyon_Script,
  Playfair_Display,
  Sacramento,
  Tangerine,
  Yellowtail,
} from "next/font/google";

// ── Font instances ────────────────────────────────────────────────────────
// Each call below downloads + bundles the font at build time. Weights are
// chosen to cover what each face is actually used for in the source
// designs; we deliberately don't pull every weight to keep the bundle
// reasonable.

const allura = Allura({ subsets: ["latin"], weight: "400", display: "swap" });
const greatVibes = Great_Vibes({ subsets: ["latin"], weight: "400", display: "swap" });
const pinyonScript = Pinyon_Script({ subsets: ["latin"], weight: "400", display: "swap" });
const italianno = Italianno({ subsets: ["latin"], weight: "400", display: "swap" });
const sacramento = Sacramento({ subsets: ["latin"], weight: "400", display: "swap" });
const yellowtail = Yellowtail({ subsets: ["latin"], weight: "400", display: "swap" });
const petitFormalScript = Petit_Formal_Script({ subsets: ["latin"], weight: "400", display: "swap" });
const dancingScript = Dancing_Script({ subsets: ["latin"], weight: ["400", "600", "700"], display: "swap" });
const parisienne = Parisienne({ subsets: ["latin"], weight: "400", display: "swap" });
const tangerine = Tangerine({ subsets: ["latin"], weight: ["400", "700"], display: "swap" });
const alexBrush = Alex_Brush({ subsets: ["latin"], weight: "400", display: "swap" });
const pacifico = Pacifico({ subsets: ["latin"], weight: "400", display: "swap" });

const cinzel = Cinzel({ subsets: ["latin"], weight: ["400", "600", "700"], display: "swap" });
const cinzelDecorative = Cinzel_Decorative({ subsets: ["latin"], weight: ["400", "700"], display: "swap" });
const playfairDisplay = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});
const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});
const crimsonText = Crimson_Text({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  display: "swap",
});
const cardo = Cardo({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  display: "swap",
});
const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});
const lato = Lato({ subsets: ["latin"], weight: ["300", "400", "700"], display: "swap" });

// ── Public registry ───────────────────────────────────────────────────────

export type FontCategory = "script" | "display" | "body";

export interface FontEntry {
  /** Short stable id used in serialised state. Don't rename casually —
   *  changing this breaks any saved text layers referencing the font. */
  id: string;
  /** Human-friendly name shown in the picker. */
  label: string;
  /** What kind of role this font fills in a typical invite layout.
   *  Drives the picker grouping and the smart defaults (e.g. a script
   *  font defaults to a larger size than body text). */
  category: FontCategory;
  /** The runtime CSS family string. Suitable for both `style.fontFamily`
   *  and `ctx.font` strings — they're the same hashed name produced by
   *  next/font/google. */
  family: string;
  /** Weights actually bundled for this font. */
  weights: number[];
  /** Whether the font has a true italic. Affects the Inspector controls. */
  hasItalic: boolean;
  /** Recommended default font size (in em-relative units, multiplied by
   *  source-canvas height when used). Scripts read big; body reads
   *  small. */
  defaultSizeFactor: number;
  /** Short tagline shown under the font name in the picker, describing
   *  the look so the user can pick by feel without zooming on every
   *  preview. */
  vibe: string;
  /** Optional reference: which invitation screenshot inspired adding
   *  this font. Useful for debugging / tuning the curation later. */
  inspiredBy?: string;
}

export const FONT_REGISTRY: FontEntry[] = [
  // ── Script: hero name / "Quince Años" calligraphy ───────────────────────
  {
    id: "allura",
    label: "Allura",
    category: "script",
    family: allura.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.13,
    vibe: "Classic copperplate, flowing flourishes",
    inspiredBy: "Yamell Pérez Guzman, Kailyn Marie",
  },
  {
    id: "great-vibes",
    label: "Great Vibes",
    category: "script",
    family: greatVibes.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.13,
    vibe: "Romantic loops, formal feel",
  },
  {
    id: "pinyon-script",
    label: "Pinyon Script",
    category: "script",
    family: pinyonScript.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.13,
    vibe: "Delicate, traditional invitation script",
  },
  {
    id: "italianno",
    label: "Italianno",
    category: "script",
    family: italianno.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.16,
    vibe: "Tall, slanted, very elegant",
    inspiredBy: "Miley Govea Soto, Genesis Nicole",
  },
  {
    id: "petit-formal-script",
    label: "Petit Formal Script",
    category: "script",
    family: petitFormalScript.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.12,
    vibe: "Compact, refined, Spencerian",
  },
  {
    id: "alex-brush",
    label: "Alex Brush",
    category: "script",
    family: alexBrush.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.14,
    vibe: "Hand-painted brush, casual elegance",
  },
  {
    id: "sacramento",
    label: "Sacramento",
    category: "script",
    family: sacramento.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.12,
    vibe: "Modern handwritten, friendly",
  },
  {
    id: "yellowtail",
    label: "Yellowtail",
    category: "script",
    family: yellowtail.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.12,
    vibe: "Retro brush script, bold strokes",
    inspiredBy: "Sheidy's",
  },
  {
    id: "parisienne",
    label: "Parisienne",
    category: "script",
    family: parisienne.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.12,
    vibe: "Modern script, slight slant",
  },
  {
    id: "tangerine",
    label: "Tangerine",
    category: "script",
    family: tangerine.style.fontFamily,
    weights: [400, 700],
    hasItalic: false,
    defaultSizeFactor: 0.16,
    vibe: "Tall thin script, lots of x-height variation",
  },
  {
    id: "dancing-script",
    label: "Dancing Script",
    category: "script",
    family: dancingScript.style.fontFamily,
    weights: [400, 600, 700],
    hasItalic: false,
    defaultSizeFactor: 0.11,
    vibe: "Playful casual script",
  },
  {
    id: "pacifico",
    label: "Pacifico",
    category: "script",
    family: pacifico.style.fontFamily,
    weights: [400],
    hasItalic: false,
    defaultSizeFactor: 0.10,
    vibe: "Retro brush, fun",
  },

  // ── Display: Trajan-style Roman caps for "QUINCEAÑERA" lines ────────────
  {
    id: "cinzel",
    label: "Cinzel",
    category: "display",
    family: cinzel.style.fontFamily,
    weights: [400, 600, 700],
    hasItalic: false,
    defaultSizeFactor: 0.06,
    vibe: "Refined Trajan-style caps. The classic invite display.",
    inspiredBy: "QUINCEAÑERA, SABADO 15 NOVIEMBRE",
  },
  {
    id: "cinzel-decorative",
    label: "Cinzel Decorative",
    category: "display",
    family: cinzelDecorative.style.fontFamily,
    weights: [400, 700],
    hasItalic: false,
    defaultSizeFactor: 0.06,
    vibe: "Cinzel with optional flourishes on caps",
  },
  {
    id: "playfair-display",
    label: "Playfair Display",
    category: "display",
    family: playfairDisplay.style.fontFamily,
    weights: [400, 600, 700],
    hasItalic: true,
    defaultSizeFactor: 0.07,
    vibe: "High-contrast modern serif, magazine feel",
  },

  // ── Body: addresses, "Please join us…", date lines ──────────────────────
  {
    id: "cormorant-garamond",
    label: "Cormorant Garamond",
    category: "body",
    family: cormorantGaramond.style.fontFamily,
    weights: [400, 500, 600, 700],
    hasItalic: true,
    defaultSizeFactor: 0.035,
    vibe: "Refined serif with elegant italic",
    inspiredBy: "GABRIEL PATIÑO & MAGALI PLIEGO body lines",
  },
  {
    id: "eb-garamond",
    label: "EB Garamond",
    category: "body",
    family: ebGaramond.style.fontFamily,
    weights: [400, 500, 600, 700],
    hasItalic: true,
    defaultSizeFactor: 0.035,
    vibe: "Classic Garamond, very readable",
  },
  {
    id: "crimson-text",
    label: "Crimson Text",
    category: "body",
    family: crimsonText.style.fontFamily,
    weights: [400, 600, 700],
    hasItalic: true,
    defaultSizeFactor: 0.035,
    vibe: "Old-style serif, warm tone",
  },
  {
    id: "cardo",
    label: "Cardo",
    category: "body",
    family: cardo.style.fontFamily,
    weights: [400, 700],
    hasItalic: true,
    defaultSizeFactor: 0.035,
    vibe: "Scholarly serif, very neutral",
  },
  {
    id: "montserrat",
    label: "Montserrat",
    category: "body",
    family: montserrat.style.fontFamily,
    weights: [300, 400, 500, 600, 700],
    hasItalic: false,
    defaultSizeFactor: 0.03,
    vibe: "Clean geometric sans (uppercase reads well)",
    inspiredBy: "NOVEMBER 1, 2025 / RSVP TO MONICA",
  },
  {
    id: "lato",
    label: "Lato",
    category: "body",
    family: lato.style.fontFamily,
    weights: [300, 400, 700],
    hasItalic: false,
    defaultSizeFactor: 0.03,
    vibe: "Friendly humanist sans",
  },
];

// ── Lookup helpers ────────────────────────────────────────────────────────

const FONT_BY_ID = new Map<string, FontEntry>(
  FONT_REGISTRY.map((f) => [f.id, f])
);

export function getFont(id: string): FontEntry | undefined {
  return FONT_BY_ID.get(id);
}

/** Default font for a freshly-added text layer. Picked to be safe and
 *  recognisable — Cormorant Garamond reads as "obviously a font", isn't
 *  too decorative, and works at any reasonable size. */
export const DEFAULT_FONT_ID = "cormorant-garamond";

export function getFontsByCategory(category: FontCategory): FontEntry[] {
  return FONT_REGISTRY.filter((f) => f.category === category);
}

/** Best-effort wait for a font to be ready in the document. Crucial for
 *  canvas rendering: if you call `ctx.fillText` before the font is
 *  loaded, the browser silently falls back to a system font and your
 *  print PNG ships with the wrong letterforms.
 *
 *  Returns immediately if the font is already loaded. Safe to call from
 *  SSR (no-ops if `document` isn't defined). */
export async function ensureFontLoaded(
  font: FontEntry,
  weight: number = 400,
  italic = false,
  pixelSize = 64
): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  // The font specifier matches the canvas `ctx.font` syntax. We pick a
  // reasonable size so the browser actually fetches the file (some
  // browsers skip the load if no real glyph is requested).
  const style = italic ? "italic" : "normal";
  const spec = `${style} ${weight} ${pixelSize}px ${font.family}, sans-serif`;
  try {
    await document.fonts.load(spec, "Hg"); // any non-empty string forces a fetch
  } catch {
    // Don't block on font load failures — fallback is acceptable.
  }
}
