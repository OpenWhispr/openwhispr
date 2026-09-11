#!/usr/bin/env node
// Fetches the licensed Yowza font files from the private OpenWhispr/brand-assets
// release into src/assets/fonts/yowza/, where src/brandFonts.ts picks them up
// at build time. Blaze Type's EULA forbids redistributing the files, so they
// are never committed; a build without access skips this step and the UI falls
// back to Noto Sans. Set BRAND_FONTS_REQUIRED=1 (release CI) to fail instead.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseArgs } = require("./lib/download-utils");

const REPO = "OpenWhispr/brand-assets";
const TAG = "yowza-v1";
const FILES = [
  "yowza-std-regular.otf",
  "yowza-std-medium.otf",
  "yowza-std-bold.otf",
  "yowza-soft-std-regular.otf",
  "yowza-soft-std-medium.otf",
];
const FONT_DIR = path.join(__dirname, "..", "src", "assets", "fonts", "yowza");
const REQUIRED = process.env.BRAND_FONTS_REQUIRED === "1";

function resolveToken() {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) return envToken;
  try {
    return execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function skip(reason) {
  if (REQUIRED) {
    console.error(`  [brand-fonts] ${reason}`);
    process.exit(1);
  }
  console.log(`  [brand-fonts] ${reason}; the app will fall back to Noto Sans.`);
}

function apiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "OpenWhispr-Downloader",
  };
}

async function fetchRelease(token) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`,
    { headers: apiHeaders(token) }
  );
  return response.ok ? response.json() : null;
}

// Private release assets are only served through the API asset URL with an
// octet-stream Accept header; the public browser_download_url returns 404.
async function downloadAsset(asset, token) {
  const response = await fetch(asset.url, {
    headers: { ...apiHeaders(token), Accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`${asset.name}: HTTP ${response.status}`);
  }
  fs.writeFileSync(path.join(FONT_DIR, asset.name), Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const { isForce } = parseArgs();
  const present = FILES.filter((name) => fs.existsSync(path.join(FONT_DIR, name)));
  if (present.length === FILES.length && !isForce) {
    console.log("  [brand-fonts] Yowza already present (use --force to re-download)");
    return;
  }

  const token = resolveToken();
  if (!token) {
    skip("No GitHub token and gh is not signed in");
    return;
  }

  const release = await fetchRelease(token);
  if (!release) {
    skip(`Cannot read ${REPO} release ${TAG} (no access?)`);
    return;
  }

  fs.mkdirSync(FONT_DIR, { recursive: true });
  for (const name of FILES) {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) {
      throw new Error(`Release ${TAG} has no asset ${name}`);
    }
    await downloadAsset(asset, token);
    console.log(`  [brand-fonts] Downloaded ${name}`);
  }
}

main().catch((error) => {
  console.error(`  [brand-fonts] ${error.message}`);
  process.exit(1);
});
