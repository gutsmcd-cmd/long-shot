/** Conservative browser canvas dimension limit (Chrome ~16k–32k). */
export const MAX_CANVAS_DIM = 16384;
/** Common area limit (~268MP); stay under to avoid silent failure. */
export const MAX_CANVAS_AREA = 268_435_456;

export interface ScaledShot {
  img: HTMLImageElement;
  /** Drawn width (= targetWidth). */
  width: number;
  /** Full scaled height before crop. */
  height: number;
  /** Pixels cropped from the top in scaled space (overlap). */
  cropTop: number;
}

export interface StitchPlan {
  targetWidth: number;
  totalHeight: number;
  shots: ScaledShot[];
}

export function planStitch(
  images: HTMLImageElement[],
  overlapPx: number,
): StitchPlan {
  if (images.length === 0) {
    return { targetWidth: 0, totalHeight: 0, shots: [] };
  }

  const targetWidth = Math.max(...images.map((i) => i.naturalWidth));
  const overlap = Math.max(0, Math.min(80, Math.floor(overlapPx)));

  const shots: ScaledShot[] = images.map((img, index) => {
    const scale = targetWidth / img.naturalWidth;
    const width = targetWidth;
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const cropTop =
      index === 0 ? 0 : Math.min(overlap, Math.max(0, height - 1));
    return { img, width, height, cropTop };
  });

  const totalHeight = shots.reduce(
    (sum, s) => sum + (s.height - s.cropTop),
    0,
  );

  return { targetWidth, totalHeight, shots };
}

export function assertCanvasFits(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new Error('Nothing to stitch yet.');
  }
  if (width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM) {
    throw new Error(
      `Result would be ${width}×${height}px — too tall/wide for this browser (limit ~${MAX_CANVAS_DIM}px). Use fewer or smaller screenshots.`,
    );
  }
  if (width * height > MAX_CANVAS_AREA) {
    throw new Error(
      `Result would be ${width}×${height}px — exceeds canvas memory limits. Use fewer or smaller screenshots.`,
    );
  }
}

/** Draw top-to-bottom stitch. Returns a PNG blob. */
export async function stitchToPng(
  images: HTMLImageElement[],
  overlapPx: number,
): Promise<Blob> {
  const plan = planStitch(images, overlapPx);
  assertCanvasFits(plan.targetWidth, plan.totalHeight);

  const canvas = document.createElement('canvas');
  canvas.width = plan.targetWidth;
  canvas.height = plan.totalHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create canvas context.');
  }

  let y = 0;
  for (const shot of plan.shots) {
    const scale = shot.width / shot.img.naturalWidth;
    const srcCropTop = shot.cropTop / scale;
    const sx = 0;
    const sy = srcCropTop;
    const sWidth = shot.img.naturalWidth;
    const sHeight = shot.img.naturalHeight - srcCropTop;
    const drawH = shot.height - shot.cropTop;

    ctx.drawImage(
      shot.img,
      sx,
      sy,
      sWidth,
      sHeight,
      0,
      y,
      shot.width,
      drawH,
    );
    y += drawH;
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(
          new Error(
            'Failed to encode PNG — the canvas may be too large. Try fewer or smaller screenshots.',
          ),
        );
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
