const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ASSETS = path.join(__dirname, "..", "..", "src", "assets");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readIcoEntries(ico) {
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const at = 6 + index * 16;
    const offset = ico.readUInt32LE(at + 12);
    return { size: ico[at] || 256, data: ico.subarray(offset, offset + ico.readUInt32LE(at + 8)) };
  });
}

function decodePng(png) {
  let width;
  let height;
  const compressed = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.deepEqual(
        [body[8], body[9], body[12]],
        [8, 6, 0],
        "expected 8-bit RGBA, not interlaced"
      );
    } else if (type === "IDAT") {
      compressed.push(body);
    }
    at += length + 12;
  }

  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const estimate = left + up - upLeft;
      const [toLeft, toUp, toUpLeft] = [left, up, upLeft].map((value) =>
        Math.abs(estimate - value)
      );
      const paeth = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, pixels };
}

// A 32-bit ICO bitmap: a BITMAPINFOHEADER with doubled height, then bottom-up BGRA rows.
function decodeBitmap(dib) {
  const width = dib.readInt32LE(4);
  assert.equal(dib.readUInt16LE(14), 32, "expected a 32-bit bitmap");
  const headerSize = dib.readUInt32LE(0);
  const pixels = Buffer.alloc(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const from = headerSize + ((width - 1 - y) * width + x) * 4;
      const to = (y * width + x) * 4;
      pixels.set([dib[from + 2], dib[from + 1], dib[from], dib[from + 3]], to);
    }
  }
  return { width, pixels };
}

// Area-averages a square RGBA image down to `size`, with colour weighted by alpha so transparent
// pixels count the same whatever colour they carry.
function premultipliedAt({ width, pixels }, size) {
  const scale = width / size;
  const result = new Float64Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const to = (y * size + x) * 4;
      for (let sourceY = Math.floor(y * scale); sourceY < Math.ceil((y + 1) * scale); sourceY++) {
        const rowWeight = Math.min(sourceY + 1, (y + 1) * scale) - Math.max(sourceY, y * scale);
        for (let sourceX = Math.floor(x * scale); sourceX < Math.ceil((x + 1) * scale); sourceX++) {
          const weight =
            rowWeight * (Math.min(sourceX + 1, (x + 1) * scale) - Math.max(sourceX, x * scale));
          const from = (sourceY * width + sourceX) * 4;
          const alpha = pixels[from + 3];
          for (let channel = 0; channel < 3; channel++) {
            result[to + channel] += (weight * pixels[from + channel] * alpha) / 255;
          }
          result[to + 3] += weight * alpha;
        }
      }
    }
  }
  return result.map((value) => value / (scale * scale));
}

function meanDifference(a, b) {
  return a.reduce((total, value, index) => total + Math.abs(value - b[index]), 0) / a.length;
}

const iconEntries = readIcoEntries(fs.readFileSync(path.join(ASSETS, "icon.ico")));

test("icon.ico has entries from 16 to 256 px, including 72 and 96 px for desktop icons at 150% and 200%", () => {
  const sizes = iconEntries.map((entry) => entry.size);
  for (const size of [16, 24, 32, 48, 64, 72, 96, 128, 256]) {
    assert.ok(sizes.includes(size), `missing ${size} px entry`);
  }
});

// Entries under 48 px are left out, since they may be hand-tuned. This measures how closely an
// entry follows icon.png, not how sharp it is. The limit of 4 sits between Pillow's and ffmpeg's
// Lanczos, bicubic, bilinear and area downscales of icon.png (up to about 2.2) and the blurry ICO
// this replaced (7.1 and up), so a nearest-neighbour downscale still passes, and a sharp macOS
// sips rebuild, whose art comes out slightly smaller, fails at 48 px (5.5).
test("every icon.ico entry of 48 px and up matches icon.png scaled to its size", () => {
  const art = decodePng(fs.readFileSync(path.join(ASSETS, "icon.png")));
  for (const { size, data } of iconEntries.filter((entry) => entry.size >= 48)) {
    const entry = data.subarray(0, 8).equals(PNG_SIGNATURE) ? decodePng(data) : decodeBitmap(data);
    assert.equal(entry.width, size);
    const difference = meanDifference(premultipliedAt(entry, size), premultipliedAt(art, size));
    assert.ok(difference < 4, `${size} px entry differs from icon.png by ${difference.toFixed(2)}`);
  }
});
