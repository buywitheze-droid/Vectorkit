/**
 * AI-based background removal using @imgly/background-removal.
 * Runs entirely in the browser via ONNX. The first call downloads the model
 * (~80MB for "small", ~180MB for "medium"); subsequent calls hit the cache.
 */

import { removeBackground, type Config } from "@imgly/background-removal";

export type AiModel = "isnet_fp16" | "isnet_quint8";

export interface AiRemovalOptions {
  /**
   * "fast" → isnet_quint8 (~80 MB, faster load + inference)
   * "high" → isnet_fp16 (~180 MB, higher quality edges)
   */
  quality: "fast" | "high";
  onProgress?: (key: string, current: number, total: number) => void;
}

export async function removeBackgroundAi(
  source: Blob | File | string,
  opts: AiRemovalOptions
): Promise<Blob> {
  const model: AiModel = opts.quality === "high" ? "isnet_fp16" : "isnet_quint8";
  const config: Config = {
    model,
    output: { format: "image/png" },
    progress: opts.onProgress,
  };
  return await removeBackground(source, config);
}
