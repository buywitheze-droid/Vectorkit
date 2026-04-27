/**
 * Resize / upscale an image with quality smoothing.
 *
 * Uses repeated downscaling for shrinks (preserves detail much better than
 * a single high-quality draw) and a single high-quality interpolated draw
 * for upscales. Browser canvas does Lanczos-like resampling when
 * imageSmoothingQuality is "high".
 */

import { canvasToBlob, imageToCanvas } from "./canvas";

export interface ResizeOptions {
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  /** Stretch (allow distortion) or letterbox (preserve aspect, transparent padding). */
  fit: "stretch" | "contain" | "cover";
  /** Optional DPI to embed in the PNG output (informational; doesn't affect canvas). */
  dpi?: number;
}

export async function resizeImage(
  source: HTMLImageElement | HTMLCanvasElement,
  opts: ResizeOptions
): Promise<HTMLCanvasElement> {
  const srcW = "naturalWidth" in source ? source.naturalWidth : source.width;
  const srcH = "naturalHeight" in source ? source.naturalHeight : source.height;
  const { width: dstW, height: dstH, fit } = opts;

  // For shrinks beyond 2x, do progressive halving for better quality.
  let working: HTMLCanvasElement = "naturalWidth" in source ? imageToCanvas(source) : source;

  if (fit === "stretch") {
    while (working.width > dstW * 2 && working.height > dstH * 2) {
      working = halveCanvas(working);
    }
    return drawTo(working, dstW, dstH, "stretch");
  }

  // contain or cover — compute target rect.
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let drawW: number, drawH: number;

  if (fit === "contain") {
    if (srcAspect > dstAspect) {
      drawW = dstW;
      drawH = Math.round(dstW / srcAspect);
    } else {
      drawH = dstH;
      drawW = Math.round(dstH * srcAspect);
    }
  } else {
    // cover
    if (srcAspect > dstAspect) {
      drawH = dstH;
      drawW = Math.round(dstH * srcAspect);
    } else {
      drawW = dstW;
      drawH = Math.round(dstW / srcAspect);
    }
  }

  // Progressive halving toward target draw size.
  while (working.width > drawW * 2 && working.height > drawH * 2) {
    working = halveCanvas(working);
  }

  const out = document.createElement("canvas");
  out.width = dstW;
  out.height = dstH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const offsetX = Math.round((dstW - drawW) / 2);
  const offsetY = Math.round((dstH - drawH) / 2);
  ctx.drawImage(working, offsetX, offsetY, drawW, drawH);
  return out;
}

function halveCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.floor(src.width / 2));
  out.height = Math.max(1, Math.floor(src.height / 2));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function drawTo(
  src: HTMLCanvasElement,
  dstW: number,
  dstH: number,
  _fit: "stretch"
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = dstW;
  out.height = dstH;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, dstW, dstH);
  return out;
}

/**
 * Embed a pHYs chunk in a PNG blob to mark the DPI so print software
 * (Photoshop, DTF RIPs, etc.) reads the correct physical size.
 *
 * PNG pHYs chunk format:
 *   4 bytes: pixels per unit, X axis (uint32 BE)
 *   4 bytes: pixels per unit, Y axis (uint32 BE)
 *   1 byte:  unit specifier (1 = meter)
 */
export async function setPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Verify PNG signature.
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return blob;
  }

  const ppm = Math.round(dpi * 39.3701); // 1 inch = 0.0254 m, 1/0.0254 ≈ 39.3701

  // Build the pHYs chunk: 4 length + "pHYs" + data + 4 CRC
  const chunkData = new Uint8Array(9);
  const view = new DataView(chunkData.buffer);
  view.setUint32(0, ppm, false);
  view.setUint32(4, ppm, false);
  chunkData[8] = 1; // meters

  const chunkType = new Uint8Array([0x70, 0x48, 0x59, 0x73]); // "pHYs"
  const crcInput = new Uint8Array(chunkType.length + chunkData.length);
  crcInput.set(chunkType, 0);
  crcInput.set(chunkData, chunkType.length);
  const crc = crc32(crcInput);

  const chunk = new Uint8Array(4 + 4 + chunkData.length + 4);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, chunkData.length, false);
  chunk.set(chunkType, 4);
  chunk.set(chunkData, 8);
  chunkView.setUint32(8 + chunkData.length, crc, false);

  // Insert pHYs after IHDR (which is the first chunk after the 8-byte signature).
  // IHDR is always: 4 length + 4 type + 13 data + 4 crc = 25 bytes starting at offset 8.
  const insertAt = 8 + 25;

  // Remove any existing pHYs chunk to avoid duplicates.
  const cleaned = removeChunk(bytes, "pHYs");

  const out = new Uint8Array(cleaned.length + chunk.length);
  out.set(cleaned.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(cleaned.subarray(insertAt), insertAt + chunk.length);

  return new Blob([out.buffer as ArrayBuffer], { type: "image/png" });
}

function removeChunk(bytes: Uint8Array, type: string): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  let offset = 8;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0, false);
    const matches =
      bytes[offset + 4] === typeBytes[0] &&
      bytes[offset + 5] === typeBytes[1] &&
      bytes[offset + 6] === typeBytes[2] &&
      bytes[offset + 7] === typeBytes[3];
    const totalLength = 4 + 4 + length + 4;
    if (matches) {
      const out = new Uint8Array(bytes.length - totalLength);
      out.set(bytes.subarray(0, offset), 0);
      out.set(bytes.subarray(offset + totalLength), offset);
      return out;
    }
    offset += totalLength;
  }
  return bytes;
}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export { canvasToBlob };
