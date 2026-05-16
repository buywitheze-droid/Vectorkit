/**
 * Minimal ambient typings for potrace-plus (no official .d.ts ships with
 * the package). We only declare what we actually call from textVectorize.ts.
 */

declare module "potrace-plus" {
  export interface PotracePlusOptions {
    turnpolicy?: string;
    turdsize?: number;
    optcurve?: boolean;
    alphamax?: number;
    opttolerance?: number;
    minSize?: number;
    maxSize?: number;
    scale?: number;
    brightness?: number;
    contrast?: number;
    invert?: number;
    blur?: number;
    crop?: boolean;
    optimize?: boolean;
    addDimensions?: boolean;
    toRelative?: boolean;
    toShorthands?: boolean;
    decimals?: number;
    getPolygon?: boolean;
    getPDF?: boolean;
  }

  export interface PotracePlusResult {
    /** SVG document string. */
    svg?: string;
    /** SVG with split paths per shape. */
    svgSplit?: string;
    /** Concatenated path data attribute (`d` value of a single <path>). */
    d?: string;
    width?: number;
    height?: number;
    commands?: number;
    pathData?: unknown[];
    pdf?: string;
    getSVG?: (split?: boolean) => string;
    getD?: () => string;
    getPathData?: () => unknown[];
    getPathDataNorm?: () => unknown[];
  }

  export function PotracePlus(
    source:
      | HTMLImageElement
      | HTMLCanvasElement
      | ImageData
      | ImageBitmap
      | string,
    options?: PotracePlusOptions
  ): Promise<PotracePlusResult>;

  export function getSVGData(
    pathData: unknown,
    options?: PotracePlusOptions
  ): string;
}
