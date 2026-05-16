/**
 * Preset trainer — interactive critique-driven preset tuning.
 *
 * The "agent" is a deterministic rule-based engine. The user clicks a critique
 * chip ("background still showing", "halo on edges", etc.) or types a freeform
 * description; we map it to a parameter delta and re-apply chromakey live.
 *
 * Cross-image learning is achieved by tuning the SAME draft params against
 * multiple test images sequentially — so the final preset is the "consensus"
 * settings that produced clean results on every image the user accepted.
 *
 * No ML. No API calls. All client-side, all transparent: the user sees every
 * adjustment as a numeric delta on screen.
 */

import type { ChromakeyParams } from "@/components/panels/BgRemovalPanel";

export type CritiqueId =
  | "amount-not-enough"
  | "amount-too-much"
  | "interior-lost"
  | "edge-halo"
  | "edge-jaggy"
  | "edge-shrunk"
  | "edge-soft"
  | "color-tint"
  | "color-tint-clean";

export interface Critique {
  id: CritiqueId;
  /** Short label for chip UI. */
  label: string;
  /** Tooltip / longer description. */
  description: string;
  /** Which "concern" group it falls under (drives chip section grouping). */
  group: "amount" | "interior" | "edges" | "color";
}

export const CRITIQUES: Critique[] = [
  {
    id: "amount-not-enough",
    label: "Background still showing",
    description: "Not enough was removed — increase tolerance.",
    group: "amount",
  },
  {
    id: "amount-too-much",
    label: "Removed too much of the design",
    description: "The subject lost pixels — decrease tolerance / unchoke.",
    group: "amount",
  },
  {
    id: "interior-lost",
    label: "White inside the design got eaten",
    description:
      "Switch to flood-fill so only edge-connected background is removed; preserves white inside flowers/dress/letters.",
    group: "interior",
  },
  {
    id: "edge-halo",
    label: "Fuzzy halo / fringe on edges",
    description: "Increase edge choke and threshold to harden cutout edges.",
    group: "edges",
  },
  {
    id: "edge-jaggy",
    label: "Jagged stair-step edges",
    description: "Increase feather to soften before thresholding.",
    group: "edges",
  },
  {
    id: "edge-shrunk",
    label: "Edges nibbled too thin",
    description: "Reduce choke and lower threshold so more edge pixels stay.",
    group: "edges",
  },
  {
    id: "edge-soft",
    label: "Edges look too soft / blurry",
    description: "Reduce feather and ensure solid-edge thresholding is on.",
    group: "edges",
  },
  {
    id: "color-tint",
    label: "Color tint on edges",
    description:
      "Enable auto-despill — neutralizes leftover green/blue/red on edge pixels.",
    group: "color",
  },
  {
    id: "color-tint-clean",
    label: "Edges look clean (no tint)",
    description:
      "Despill not needed — disable to skip extra processing.",
    group: "color",
  },
];

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * Apply a critique to the draft params and return new params.
 * Returns the same reference shape as `ChromakeyParams` (immutable update).
 */
export function applyCritique(
  params: ChromakeyParams,
  critiqueId: CritiqueId
): { next: ChromakeyParams; explanation: string } {
  const next: ChromakeyParams = {
    ...params,
    finish: { ...params.finish },
  };
  const notes: string[] = [];

  switch (critiqueId) {
    case "amount-not-enough": {
      const delta = next.tolerance < 15 ? 4 : 3;
      next.tolerance = clamp(next.tolerance + delta, 0, 50);
      notes.push(`tolerance +${delta} → ${next.tolerance}%`);
      // If tolerance is already high and BG still shows, the fill probably isn't
      // reaching enclosed BG pockets — switch to global as a fallback hint.
      if (params.tolerance >= 25 && next.strategy === "flood") {
        notes.push(
          `(tip: at high tolerance, consider trying "Everywhere" strategy if bg is enclosed)`
        );
      }
      break;
    }
    case "amount-too-much": {
      next.tolerance = clamp(next.tolerance - 3, 0, 50);
      notes.push(`tolerance −3 → ${next.tolerance}%`);
      if (next.finish.choke > 0) {
        next.finish.choke = clamp(next.finish.choke - 1, 0, 5);
        notes.push(`choke −1 → ${next.finish.choke}px`);
      }
      break;
    }
    case "interior-lost": {
      if (next.strategy !== "flood") {
        next.strategy = "flood";
        notes.push(`strategy → flood (preserves enclosed pixels)`);
      } else {
        // Already flood — maybe tolerance is too high, snipping into edges.
        next.tolerance = clamp(next.tolerance - 2, 0, 50);
        notes.push(`tolerance −2 → ${next.tolerance}% (already flood)`);
      }
      break;
    }
    case "edge-halo": {
      next.finish.solidEdges = true;
      next.finish.choke = clamp(next.finish.choke + 1, 0, 5);
      next.finish.alphaThreshold = clamp(next.finish.alphaThreshold + 16, 1, 254);
      notes.push(
        `choke +1 → ${next.finish.choke}px, threshold +16 → ${next.finish.alphaThreshold}`
      );
      break;
    }
    case "edge-jaggy": {
      next.edgeFeather = clamp(next.edgeFeather + 1, 0, 5);
      notes.push(`feather +1 → ${next.edgeFeather}px`);
      break;
    }
    case "edge-shrunk": {
      next.finish.choke = clamp(next.finish.choke - 1, 0, 5);
      next.finish.alphaThreshold = clamp(next.finish.alphaThreshold - 16, 1, 254);
      notes.push(
        `choke −1 → ${next.finish.choke}px, threshold −16 → ${next.finish.alphaThreshold}`
      );
      break;
    }
    case "edge-soft": {
      next.edgeFeather = clamp(next.edgeFeather - 1, 0, 5);
      next.finish.solidEdges = true;
      notes.push(
        `feather −1 → ${next.edgeFeather}px, solid-edges enforced`
      );
      break;
    }
    case "color-tint": {
      if (!next.finish.despill) {
        next.finish.despill = true;
        notes.push(`auto-despill enabled`);
      } else {
        notes.push(`despill already on (no further action)`);
      }
      break;
    }
    case "color-tint-clean": {
      if (next.finish.despill) {
        next.finish.despill = false;
        notes.push(`auto-despill disabled (skipping extra step)`);
      } else {
        notes.push(`despill already off`);
      }
      break;
    }
  }

  return { next, explanation: notes.join(", ") };
}

// ─── Freeform text → critique mapping ───────────────────────────────────────

interface KeywordRule {
  pattern: RegExp;
  critique: CritiqueId;
}

// Order matters: more specific rules should come before generic ones.
const KEYWORD_RULES: KeywordRule[] = [
  // Interior loss patterns (very specific, check first).
  {
    pattern:
      /\b(inside|interior|inner|within|center|middle)\b.*\b(white|light|gone|removed|missing|lost|eaten|disappear)/i,
    critique: "interior-lost",
  },
  {
    pattern:
      /\b(white|light)\b.*\b(inside|interior|inner|within)\b.*\b(gone|removed|missing|lost|eaten|disappear)/i,
    critique: "interior-lost",
  },
  {
    pattern:
      /\b(flowers?|dress|butterfl(y|ies)|letters?|crown|hair)\b.*\b(white|gone|removed|missing|lost|eaten|disappear)/i,
    critique: "interior-lost",
  },

  // Edge halo / fringe.
  {
    pattern: /\b(halo|fringe|fuzzy|fuzz|glow|aura|outline.*background|ghost)\b/i,
    critique: "edge-halo",
  },

  // Jagged edges.
  {
    pattern: /\b(jagged|jaggy|jaggies|stair|aliased|pixelated edges?|stepped)\b/i,
    critique: "edge-jaggy",
  },

  // Shrunken / nibbled edges.
  {
    pattern:
      /\b(nibbled|chewed|eaten|bitten|too small|shrunk|shrank|outline lost|too thin|chopped)\b/i,
    critique: "edge-shrunk",
  },

  // Soft / blurry edges.
  {
    pattern: /\b(blurr?y|smudged?|too soft|soft edges?|fuzzy soft)\b/i,
    critique: "edge-soft",
  },

  // Color tint / spill.
  {
    pattern:
      /\b(tint(ed)?|spill|colou?r.*edges?|green.*edges?|yellow.*edges?|gray.*edges?|blue.*edges?)\b/i,
    critique: "color-tint",
  },

  // Amount: too much removed.
  {
    pattern:
      /\b(removed|deleted|gone|missing).{0,30}\b(too much|too many|much of|subject|design|all)\b/i,
    critique: "amount-too-much",
  },
  {
    pattern: /\b(too aggressive|over.?(removed|did)|ate the (design|subject))/i,
    critique: "amount-too-much",
  },

  // Amount: not enough removed.
  {
    pattern:
      /\b(background|bg).{0,30}\b(still|left|visible|shown|showing|remain|there)/i,
    critique: "amount-not-enough",
  },
  {
    pattern: /\b(not enough|didn'?t remove|need.*more|missed (some|spots))/i,
    critique: "amount-not-enough",
  },
];

/**
 * Map freeform user description to one or more critiques.
 * Returns critiques in priority order; UI may apply all of them or just the
 * top one.
 */
export function parseFreeformCritique(text: string): CritiqueId[] {
  if (!text || !text.trim()) return [];
  const matches: CritiqueId[] = [];
  const seen = new Set<CritiqueId>();
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text) && !seen.has(rule.critique)) {
      seen.add(rule.critique);
      matches.push(rule.critique);
    }
  }
  return matches;
}

/**
 * Apply multiple critiques sequentially. Each delta accumulates.
 */
export function applyCritiques(
  params: ChromakeyParams,
  critiqueIds: CritiqueId[]
): { next: ChromakeyParams; explanations: string[] } {
  let cur = params;
  const explanations: string[] = [];
  for (const id of critiqueIds) {
    const { next, explanation } = applyCritique(cur, id);
    cur = next;
    const meta = CRITIQUES.find((c) => c.id === id);
    explanations.push(`${meta?.label ?? id}: ${explanation}`);
  }
  return { next: cur, explanations };
}

// ─── Sample tracking ───────────────────────────────────────────────────────

export interface TrainingSample {
  id: string;
  /** Display name (file name). */
  name: string;
  /** Source canvas (the original loaded image). */
  source: HTMLCanvasElement;
  /** Critique IDs applied while tuning this sample (in order). */
  critiques: CritiqueId[];
  /** Snapshot of params after the user marked this sample "good". */
  acceptedParams: ChromakeyParams | null;
}

/**
 * Aggregate accepted-param snapshots across samples to produce a "consensus"
 * preset. Numeric values are averaged; booleans take majority vote; strategy
 * takes whichever was used most often.
 *
 * If only one sample was accepted, returns its params unchanged.
 */
export function aggregateSamples(
  samples: TrainingSample[]
): ChromakeyParams | null {
  const accepted = samples
    .map((s) => s.acceptedParams)
    .filter((p): p is ChromakeyParams => p !== null);
  if (accepted.length === 0) return null;
  if (accepted.length === 1) return accepted[0];

  const avgN = (key: keyof Pick<ChromakeyParams, "tolerance" | "edgeFeather">) =>
    Math.round(accepted.reduce((s, p) => s + p[key], 0) / accepted.length);
  const avgFinishN = (
    key: keyof Pick<
      ChromakeyParams["finish"],
      "alphaThreshold" | "choke"
    >
  ) =>
    Math.round(
      accepted.reduce((s, p) => s + p.finish[key], 0) / accepted.length
    );
  const majorityBool = (
    pick: (p: ChromakeyParams) => boolean
  ): boolean => accepted.filter(pick).length * 2 >= accepted.length;
  const majorityStrategy = (): "flood" | "global" => {
    const flood = accepted.filter((p) => p.strategy === "flood").length;
    return flood * 2 >= accepted.length ? "flood" : "global";
  };

  // Color: take the most common value, fall back to the first accepted.
  const colorCounts = new Map<string, number>();
  for (const p of accepted) {
    colorCounts.set(p.color, (colorCounts.get(p.color) ?? 0) + 1);
  }
  let topColor = accepted[0].color;
  let topCount = 0;
  for (const [c, n] of colorCounts) {
    if (n > topCount) {
      topCount = n;
      topColor = c;
    }
  }

  return {
    color: topColor,
    tolerance: avgN("tolerance"),
    strategy: majorityStrategy(),
    edgeFeather: avgN("edgeFeather"),
    finish: {
      solidEdges: majorityBool((p) => p.finish.solidEdges),
      alphaThreshold: avgFinishN("alphaThreshold"),
      choke: avgFinishN("choke"),
      despill: majorityBool((p) => p.finish.despill),
    },
  };
}
