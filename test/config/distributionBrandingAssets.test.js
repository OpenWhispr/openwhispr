const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { loadDistribution } = require("../../src/config/distributionSchema.ts");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function assetPath(relative) {
  return path.join(PROJECT_ROOT, relative);
}

function readMagic(relative, length) {
  const handle = fs.openSync(assetPath(relative), "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, 0);
    return buffer;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * The branding assets are the one part of the fork a user sees before anything
 * else works. A missing file, or a PNG renamed to .icns, only shows up as a
 * generic Electron icon in a signed build, long after the mistake.
 */
test("every Oppulence Voice branding asset exists", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", PROJECT_ROOT);

  for (const [name, relative] of Object.entries(distribution.assets)) {
    if (!relative || name === "macAssetCatalog") continue;
    assert.ok(fs.existsSync(assetPath(relative)), `${name} is missing: ${relative}`);
  }
});

test("platform icons are in the format their packager requires", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", PROJECT_ROOT);

  // electron-builder does not transcode these: a PNG named .icns produces a
  // blank Mac icon rather than an error.
  assert.equal(readMagic(distribution.assets.macIcon, 4).toString("hex"), "69636e73", "macIcon must be a real .icns");
  assert.equal(readMagic(distribution.assets.windowsIcon, 4).toString("hex"), "00000100", "windowsIcon must be a real .ico");

  const pngMagic = "89504e470d0a1a0a";
  for (const name of ["rendererLogo", "rendererIcon", "trayIcon", "linuxIcon"]) {
    assert.equal(readMagic(distribution.assets[name], 8).toString("hex"), pngMagic, `${name} must be a PNG`);
  }
});

test("the macOS tray icon is a small template image", () => {
  const distribution = loadDistribution("distributions/oppulence-voice.json", PROJECT_ROOT);

  // tray.js calls setTemplateImage(true) on darwin, which keeps only the alpha
  // channel. A full-colour app icon there renders as a black blob, and a
  // 512px source is scaled into a smudge in the menu bar.
  const header = readMagic(distribution.assets.trayIcon, 24);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);

  assert.ok(width <= 64 && height <= 64, `tray icon is ${width}x${height}; menu-bar art should be <= 64px`);
  assert.match(
    distribution.assets.trayIcon,
    /Template(@\dx)?\.png$/,
    "macOS template images must keep the Template suffix so Electron treats them as masks"
  );
});
