/**
 * Browser-canvas polyfill so we can run the real `src/lib/image/*.ts` code
 * in Node via @napi-rs/canvas. Import this BEFORE any image lib imports.
 */
import { createCanvas, Image as NapiImage, ImageData as NapiImageData, loadImage as napiLoadImage } from "@napi-rs/canvas";

// Stub document just enough that our libs can call document.createElement('canvas').
// All other tags throw — we should never need them server-side.
const documentStub = {
  createElement: (tag: string) => {
    if (tag === "canvas") return createCanvas(1, 1);
    throw new Error(`[test setup] document.createElement('${tag}') not supported`);
  },
};

if (typeof globalThis.document === "undefined") {
  // @ts-expect-error stubbing browser global for testing
  globalThis.document = documentStub;
}

if (typeof globalThis.Image === "undefined") {
  // @ts-expect-error stubbing browser global for testing
  globalThis.Image = NapiImage;
}

if (typeof globalThis.ImageData === "undefined") {
  // @ts-expect-error stubbing browser global for testing
  globalThis.ImageData = NapiImageData;
}

// Re-export helpers tests can use directly.
export { createCanvas, napiLoadImage as loadImageFromPath };
