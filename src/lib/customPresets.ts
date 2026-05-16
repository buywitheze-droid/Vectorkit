/**
 * Custom user-trained presets persisted to localStorage.
 *
 * Trained presets are stored under a single key as a JSON array. They are
 * merged with the built-in BG_REMOVAL_PRESETS at runtime by `getAllPresets`.
 */

import { BG_REMOVAL_PRESETS, type BgRemovalPreset } from "./presets";

const STORAGE_KEY = "vectorkit:custom-presets:v1";

export interface CustomPreset extends BgRemovalPreset {
  /** Marks this preset as user-created (vs built-in). */
  custom: true;
  /** ISO timestamp when it was saved. */
  createdAt: string;
  /** Optional notes the user wrote when saving. */
  notes?: string;
}

function safeParse(raw: string | null): CustomPreset[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is CustomPreset =>
        typeof p === "object" &&
        p !== null &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        p.params &&
        typeof p.params === "object"
    );
  } catch {
    return [];
  }
}

export function loadCustomPresets(): CustomPreset[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(STORAGE_KEY));
}

export function saveCustomPreset(preset: CustomPreset): void {
  if (typeof window === "undefined") return;
  const existing = loadCustomPresets().filter((p) => p.id !== preset.id);
  existing.push(preset);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

export function deleteCustomPreset(id: string): void {
  if (typeof window === "undefined") return;
  const filtered = loadCustomPresets().filter((p) => p.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export function getAllPresets(): BgRemovalPreset[] {
  return [...BG_REMOVAL_PRESETS, ...loadCustomPresets()];
}

export function isCustomPreset(p: BgRemovalPreset): p is CustomPreset {
  return (p as CustomPreset).custom === true;
}

/**
 * Generate a preset id from a name. Lowercases, replaces non-alphanum with
 * dashes, prefixes with "custom-" to avoid colliding with built-ins.
 */
export function generateCustomId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom-${slug || Date.now().toString(36)}`;
}
