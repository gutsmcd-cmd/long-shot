/**
 * Canvas limits.
 *
 * - Chrome / Edge / Firefox: max 32,767 px per side. Chrome also refuses
 *   canvases above ~268 MP (268,435,456 px) total area.
 * - Safari (iOS / iPadOS / macOS): max 16,777,216 px total area (4096²)
 *   per canvas; anything larger silently yields a blank canvas / null blob.
 *
 * We stay a little under the hard per-side limit and pick the area cap per
 * engine. Past the limit we no longer fail — the output is split into
 * several tall parts instead.
 */
export const HARD_CANVAS_DIM = 32_767;
/** Per-side limit we actually use (safety margin under 32,767). */
export const MAX_CANVAS_DIM = 32_000;
/** Chrome / Firefox total-area cap. */
export const MAX_CANVAS_AREA_DEFAULT = 268_435_456;
/** Safari / WebKit total-area cap (4096 × 4096). */
export const MAX_CANVAS_AREA_WEBKIT = 16_777_216;
/** Start warning when output reaches this fraction of the limit. */
export const WARN_FRACTION = 0.85;

/** Typical phone screenshot, used for the "how many fit" hint when empty. */
export const TYPICAL_SHOT = { width: 1080, height: 2400 };

function isWebKitCanvas(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
  if (iOS) return true; // every iOS browser uses WebKit
  return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\//.test(ua);
}

export const MAX_CANVAS_AREA = isWebKitCanvas()
  ? MAX_CANVAS_AREA_WEBKIT
  : MAX_CANVAS_AREA_DEFAULT;

/** Largest safe canvas height for a given output width. */
export function maxHeightFor(width: number, areaCap = MAX_CANVAS_AREA): number {
  if (width <= 0) return MAX_CANVAS_DIM;
  return Math.max(1, Math.min(MAX_CANVAS_DIM, Math.floor(areaCap / width)));
}

export interface ScaledShot {
  img: HTMLImageElement;
  /** Drawn width (= targetWidth). */
  width: number;
  /** Full scaled height before crop. */
  height: number;
  /** Pixels cropped from the top in scaled space (overlap). */
  cropTop: number;
  /** Top of this shot's visible strip in the full output (scaled space). */
  y: number;
}

export interface StitchPlan {
  targetWidth: number;
  totalHeight: number;
  /** Max height of one output image at this width. */
  maxHeight: number;
  shots: ScaledShot[];
}

export interface PartRange {
  start: number;
  end: number;
  /** True when this part ends mid-screenshot (a shot taller than the limit). */
  cutMidShot: boolean;
}

interface ImgLike {
  naturalWidth: number;
  naturalHeight: number;
}

export function planStitch<T extends ImgLike>(
  images: T[],
  overlapPx: number,
): StitchPlan {
  if (images.length === 0) {
    return { targetWidth: 0, totalHeight: 0, maxHeight: MAX_CANVAS_DIM, shots: [] };
  }

  const widest = Math.max(...images.map((i) => i.naturalWidth));
  const targetWidth = Math.min(widest, MAX_CANVAS_DIM);
  const overlap = Math.max(0, Math.min(80, Math.floor(overlapPx)));

  let y = 0;
  const shots = images.map((img, index) => {
    const scale = targetWidth / img.naturalWidth;
    const width = targetWidth;
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const cropTop =
      index === 0 ? 0 : Math.min(overlap, Math.max(0, height - 1));
    const shot = { img, width, height, cropTop, y };
    y += height - cropTop;
    return shot;
  }) as unknown as ScaledShot[];

  return { targetWidth, totalHeight: y, maxHeight: maxHeightFor(targetWidth), shots };
}

/**
 * Split [0, totalHeight) into parts no taller than maxHeight, cutting at
 * screenshot boundaries whenever possible.
 */
export function splitParts(plan: StitchPlan, maxHeight = plan.maxHeight): PartRange[] {
  const { totalHeight } = plan;
  if (totalHeight <= 0) return [];
  const boundaries = plan.shots.map((s) => s.y).slice(1); // shot tops after the first
  const parts: PartRange[] = [];
  let start = 0;
  while (start < totalHeight) {
    const limit = start + maxHeight;
    if (limit >= totalHeight) {
      parts.push({ start, end: totalHeight, cutMidShot: false });
      break;
    }
    let best = -1;
    for (const b of boundaries) {
      if (b > start && b <= limit) best = b;
    }
    if (best > start) {
      parts.push({ start, end: best, cutMidShot: false });
      start = best;
    } else {
      parts.push({ start, end: limit, cutMidShot: true });
      start = limit;
    }
  }
  return parts;
}

/** Roughly how many screenshots of this size fit in one image. */
export function shotsPerImage(
  shotWidth: number,
  shotHeight: number,
  overlapPx: number,
  outWidth = shotWidth,
): { perImage: number; maxHeight: number; scaledHeight: number } {
  const width = Math.min(outWidth, MAX_CANVAS_DIM);
  const maxHeight = maxHeightFor(width);
  const scaledHeight = Math.max(1, Math.round(shotHeight * (width / shotWidth)));
  const step = Math.max(1, scaledHeight - Math.min(80, Math.max(0, overlapPx)));
  const perImage =
    scaledHeight > maxHeight ? 0 : 1 + Math.floor((maxHeight - scaledHeight) / step);
  return { perImage, maxHeight, scaledHeight };
}

function drawPart(plan: StitchPlan, part: PartRange): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = plan.targetWidth;
  canvas.height = part.end - part.start;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas context.');

  for (const shot of plan.shots) {
    const d0 = shot.y;
    const d1 = shot.y + shot.height - shot.cropTop;
    const a = Math.max(d0, part.start);
    const b = Math.min(d1, part.end);
    if (b <= a) continue;
    const scale = shot.width / shot.img.naturalWidth;
    const srcTop = (shot.cropTop + (a - d0)) / scale;
    const srcH = (b - a) / scale;
    ctx.drawImage(
      shot.img,
      0,
      srcTop,
      shot.img.naturalWidth,
      srcH,
      0,
      a - part.start,
      shot.width,
      b - a,
    );
  }
  return canvas;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob && blob.size > 0 ? blob : null), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

export interface StitchResult {
  blobs: Blob[];
  parts: PartRange[];
  width: number;
  maxHeight: number;
}

/**
 * Draw top-to-bottom stitch as one or more PNGs. If the full image is over
 * the canvas limit it is split into parts (at screenshot boundaries where
 * possible). If the browser still refuses a part, the per-part height is
 * halved and we retry, so the save never silently fails.
 */
export async function stitchToPngs<T extends HTMLImageElement>(
  images: T[],
  overlapPx: number,
  onProgress?: (done: number, total: number) => void,
): Promise<StitchResult> {
  const plan = planStitch(images, overlapPx);
  if (plan.targetWidth <= 0 || plan.totalHeight <= 0) {
    throw new Error('Nothing to stitch yet.');
  }

  let maxHeight = plan.maxHeight;
  for (let attempt = 0; attempt < 6; attempt++) {
    const parts = splitParts(plan, maxHeight);
    const blobs: Blob[] = [];
    let failed = false;
    for (let i = 0; i < parts.length; i++) {
      onProgress?.(i, parts.length);
      const canvas = drawPart(plan, parts[i]!);
      const blob = await canvasToPng(canvas);
      canvas.width = 0; // release memory early
      canvas.height = 0;
      if (!blob) {
        failed = true;
        break;
      }
      blobs.push(blob);
    }
    if (!failed) {
      onProgress?.(parts.length, parts.length);
      return { blobs, parts, width: plan.targetWidth, maxHeight };
    }
    maxHeight = Math.max(256, Math.floor(maxHeight / 2));
  }
  throw new Error(
    'This browser could not create the image even after splitting it. Try fewer or smaller screenshots.',
  );
}
