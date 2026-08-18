#!/usr/bin/env node
/**
 * Regenerates the onboarding compact hero's dithered gradient strips.
 *
 *   node scripts/generate-onboarding-dither.js
 *
 * Writes src/assets/onboarding-hero-dither.webp (light) and
 * onboarding-hero-dither-dark.webp, falling back to .png when cwebp is missing.
 *
 * The hero ramp is a Bayer 16x16 ordered dither rather than a CSS gradient, so
 * the fade to the page surface reads as deliberate pixel art instead of a smooth
 * wash. Two details make it cheap:
 *
 *  - The ramp is purely vertical, so the pattern's horizontal period is exactly
 *    the matrix width (16 cells at CELL px). One period tiles seamlessly, so the
 *    asset is 32px wide regardless of window width and lands around 250 bytes.
 *  - The 5 levels are steps *along the gradient*, not per-channel posterisation.
 *    Posterising R/G/B independently at 5 levels drags indigo toward primary blue
 *    (0x81 -> 0.5, 0xf8 -> 1.0); stepping the ramp keeps every dithered pixel on
 *    one of the gradient's own colours.
 *
 * Consumed by .onboarding-compact-hero in src/index.css. If you change CELL or
 * HEIGHT here, update the background-size there to match.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const MATRIX = 16; // Bayer 16x16
const CELL = 2; // "Size 2" — each dither cell is 2 CSS px
const LEVELS = 5; // steps along the ramp
const HEIGHT = 192; // hero height (h-48)

const VARIANTS = [
  {
    name: "onboarding-hero-dither",
    // Tailwind bg-gradient-to-b from-indigo-400 via-indigo-300 to-white.
    stops: [
      [0, [129, 140, 248]],
      [0.5, [165, 180, 252]],
      [1, [255, 255, 255]],
    ],
  },
  {
    name: "onboarding-hero-dither-dark",
    // Same hue family, resolving into --onboarding-surface (#141414) instead of
    // white. Starts one step deeper than light so the brand mark still reads as
    // white-on-indigo at the top of the strip.
    stops: [
      [0, [92, 85, 170]], // muted indigo — full indigo-600 reads neon on a dark UI
      [0.5, [49, 46, 94]],
      [1, [20, 20, 20]], // --onboarding-surface (dark)
    ],
  },
];

/** Recursive-doubling Bayer matrix. */
function bayer(size) {
  let m = [[0]];
  for (let n = 1; n < size; n *= 2) {
    const next = Array.from({ length: n * 2 }, () => new Array(n * 2).fill(0));
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + n] = v + 2;
        next[y + n][x] = v + 3;
        next[y + n][x + n] = v + 1;
      }
    }
    m = next;
  }
  return m;
}

function sampleRamp(stops, t) {
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1 || i === stops.length - 2) {
      const f = t1 === t0 ? 0 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      return c0.map((a, k) => Math.round(a + (c1[k] - a) * f));
    }
  }
  return stops[stops.length - 1][1];
}

/** Minimal truecolor PNG encoder — enough for a handful of flat pixels. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb[y][x];
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(stops) {
  const matrix = bayer(MATRIX);
  const den = MATRIX * MATRIX;
  const rows = HEIGHT / CELL;
  const cols = MATRIX;
  const palette = Array.from({ length: LEVELS }, (_, i) => sampleRamp(stops, i / (LEVELS - 1)));

  // Dither at cell resolution, then expand each cell to CELL x CELL. Scaling
  // afterwards (rather than dithering at pixel resolution) is what makes the
  // cells square and hard-edged.
  const pixels = Array.from({ length: rows * CELL }, () => new Array(cols * CELL));
  for (let y = 0; y < rows; y++) {
    const v = (y / (rows - 1)) * (LEVELS - 1);
    for (let x = 0; x < cols; x++) {
      const threshold = (matrix[y % MATRIX][x % MATRIX] + 0.5) / den - 0.5;
      const color = palette[Math.min(LEVELS - 1, Math.max(0, Math.round(v + threshold)))];
      for (let dy = 0; dy < CELL; dy++) {
        for (let dx = 0; dx < CELL; dx++) {
          pixels[y * CELL + dy][x * CELL + dx] = color;
        }
      }
    }
  }
  return { width: cols * CELL, height: rows * CELL, pixels };
}

const assetsDir = path.join(__dirname, "..", "src", "assets");

let cwebp = true;
try {
  execFileSync("cwebp", ["-version"], { stdio: "ignore" });
} catch {
  cwebp = false;
  console.warn("cwebp not found — writing .png instead. Install it with `brew install webp`.");
}

for (const variant of VARIANTS) {
  const { width, height, pixels } = render(variant.stops);
  const pngPath = path.join(assetsDir, `${variant.name}.png`);
  fs.writeFileSync(pngPath, encodePng(width, height, pixels));

  if (!cwebp) {
    console.log(`${variant.name}.png  ${width}x${height}  ${fs.statSync(pngPath).size}B`);
    continue;
  }

  const webpPath = path.join(assetsDir, `${variant.name}.webp`);
  execFileSync("cwebp", ["-lossless", "-z", "9", "-alpha_q", "100", pngPath, "-o", webpPath], {
    stdio: "ignore",
  });
  fs.rmSync(pngPath);
  console.log(`${variant.name}.webp  ${width}x${height}  ${fs.statSync(webpPath).size}B`);
}
