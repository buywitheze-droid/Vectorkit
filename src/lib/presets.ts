/**
 * Quick presets for the "Remove Background" panel.
 *
 * Each preset is a complete, ready-to-apply ChromakeyParams blob — clicking
 * one in the UI both fills in the controls AND immediately runs the removal
 * with DTF-friendly finishing.
 *
 * To add a new preset: append to `BG_REMOVAL_PRESETS`. The shape is fully
 * validated by the ChromakeyParams type.
 */

import type {
  ChromakeyParams,
  DtfFinishOptions,
} from "@/components/panels/BgRemovalPanel";

export interface BgRemovalPreset {
  id: string;
  /** Short label shown on the chip. */
  name: string;
  /** One-line tooltip / helper text shown under the chips. */
  description: string;
  /** Emoji or short string rendered before the name. Keep to one glyph. */
  icon: string;
  params: ChromakeyParams;
}

// Reusable DTF finishing config — solid edges + light choke + auto-despill.
// This is the "safe default" for anything that will be printed (DTF, sublimation,
// vinyl, acrylic UV print) where partial-alpha pixels look terrible.
const DTF_DEFAULT: DtfFinishOptions = {
  solidEdges: true,
  alphaThreshold: 128,
  choke: 1,
  despill: true,
};

export const BG_REMOVAL_PRESETS: BgRemovalPreset[] = [
  {
    id: "acrylic-invite",
    name: "Acrylic Invite",
    icon: "💍",
    description:
      "White background removed but white details inside the design (flowers, dress, butterflies, lettering) are preserved. Tuned for quinceañera / sweet 16 / wedding invite artwork.",
    params: {
      color: "#ffffff",
      tolerance: 12,
      // Flood fill from the edges only — never touches white pixels enclosed by
      // colored design elements.
      strategy: "flood",
      edgeFeather: 1,
      finish: DTF_DEFAULT,
    },
  },
  {
    id: "logo-on-white",
    name: "Logo on White",
    icon: "🏷️",
    description:
      "Solid logo or graphic on a white background. Removes the white outside the logo and hardens edges for crisp DTF / sticker / decal print.",
    params: {
      color: "#ffffff",
      tolerance: 8,
      strategy: "flood",
      edgeFeather: 0,
      finish: { ...DTF_DEFAULT, choke: 0 },
    },
  },
  {
    id: "logo-on-black",
    name: "Logo on Black",
    icon: "⬛",
    description:
      "Logo or design on a black background (e.g. a dark mockup or scanned tee). Removes the black around the artwork while keeping any black inside the design.",
    params: {
      color: "#000000",
      tolerance: 12,
      strategy: "flood",
      edgeFeather: 1,
      finish: DTF_DEFAULT,
    },
  },
  {
    id: "green-screen",
    name: "Green Screen",
    icon: "🟢",
    description:
      "Photo or product shot on a green chroma key. Aggressive despill removes leftover green tint on edge pixels.",
    params: {
      color: "#00b140",
      tolerance: 22,
      strategy: "global",
      edgeFeather: 1,
      finish: { ...DTF_DEFAULT, choke: 0 },
    },
  },
  {
    id: "blue-screen",
    name: "Blue Screen",
    icon: "🔵",
    description:
      "Photo or product shot on a blue chroma key. Despill removes leftover blue tint on edges.",
    params: {
      color: "#0047ab",
      tolerance: 22,
      strategy: "global",
      edgeFeather: 1,
      finish: { ...DTF_DEFAULT, choke: 0 },
    },
  },
];

export function getPresetById(id: string): BgRemovalPreset | undefined {
  return BG_REMOVAL_PRESETS.find((p) => p.id === id);
}
