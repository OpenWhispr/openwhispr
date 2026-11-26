import { useEffect, useRef } from "react";

// The design's Dither effect (Bayer 16x16, size 2, colour, neutral brightness
// and contrast), with 16 levels instead of 5: at 5, neighbouring pixels jump a
// quarter of the range apart and the grain overpowers the header.
const CELL_PX = 2;
const LEVELS = 16;
const BAYER_SIZE = 16;

// Thresholds in (0, 1), built by the recursive Bayer construction.
const BAYER = (() => {
  let matrix = [[0]];
  while (matrix.length < BAYER_SIZE) {
    const n = matrix.length;
    const next = Array.from({ length: n * 2 }, () => new Array<number>(n * 2));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = matrix[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    matrix = next;
  }
  const cells = BAYER_SIZE * BAYER_SIZE;
  return matrix.map((row) => row.map((v) => (v + 0.5) / cells));
})();

/** Resolves any CSS colour (oklch, var-resolved, etc.) to sRGB 0-1 channels. */
function toRgb(ctx: CanvasRenderingContext2D, color: string): [number, number, number] {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ramp = (v: number, from: number, to: number) => clamp01((v - from) / (to - from));

function draw(canvas: HTMLCanvasElement) {
  const { width: cssWidth, height: cssHeight } = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(cssWidth / CELL_PX));
  const height = Math.max(1, Math.ceil(cssHeight / CELL_PX));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  const styles = getComputedStyle(canvas);
  const base = toRgb(ctx, styles.getPropertyValue("--color-accent").trim());
  // The lower overlay ends on the page colour itself (near-black in dark mode,
  // white in light mode). Pure black left a dotted seam against #141414.
  const surface = toRgb(ctx, styles.getPropertyValue("--onboarding-surface").trim());

  const image = ctx.createImageData(width, height);
  const steps = LEVELS - 1;
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / (height - 1);
    // White overlay lifts the top edge; the shade overlay takes over below.
    const white = 0.15 * (1 - ramp(t, 0, 0.45));
    const dark = ramp(t, 0.35, 1);
    const color = base.map((c, ch) => {
      const lifted = c + (1 - c) * white;
      return lifted + (surface[ch] - lifted) * dark;
    });
    // Fade the grain out over the last stretch so the band lands on a smooth
    // page colour instead of a dotted seam.
    const grain = 1 - ramp(t, 0.75, 1);
    const row = BAYER[y % BAYER_SIZE];
    for (let x = 0; x < width; x++) {
      const threshold = row[x % BAYER_SIZE];
      const i = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const scaled = color[ch] * steps;
        const floor = Math.floor(scaled);
        const dithered = Math.min(steps, floor + (scaled - floor > threshold ? 1 : 0)) / steps;
        image.data[i + ch] = (color[ch] + (dithered - color[ch]) * grain) * 255;
      }
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function DitheredHero({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const redraw = () => draw(canvas);
    redraw();
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    // useTheme flips body.dark; the tokens this reads change with it.
    const theme = new MutationObserver(redraw);
    theme.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
