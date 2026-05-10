#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const { downloadFile } = require("./lib/download-utils");

const DEST_DIR = path.join(__dirname, "..", "resources", "bin", "cudnn-linux-x64");
const INDEX_URL =
  "https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/linux-x86_64/";

function fetchIndex() {
  return new Promise((resolve, reject) => {
    https.get(INDEX_URL, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function findLatestCuda12Tar(html) {
  const pattern = /href="(cudnn-linux-x86_64-[\d.]+_cuda12-archive\.tar\.xz)"/g;
  const matches = [];
  let m;
  while ((m = pattern.exec(html)) !== null) {
    matches.push(m[1]);
  }
  if (matches.length === 0) return null;
  matches.sort();
  return matches[matches.length - 1];
}

async function main() {
  if (process.platform !== "linux" && !process.argv.includes("--force")) {
    console.log("[cudnn] Skipping: cuDNN bundle only needed for Linux builds");
    return;
  }

  console.log("\n[cudnn] Checking for latest cuDNN for CUDA 12...\n");

  let tarName;
  try {
    const html = await fetchIndex();
    tarName = findLatestCuda12Tar(html);
    if (!tarName) throw new Error("No CUDA 12 tar found in index");
  } catch (err) {
    console.error(`[cudnn] Failed to fetch version index: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const version = tarName.match(/cudnn-linux-x86_64-([\d.]+)_cuda12/)?.[1] || "unknown";
  const markerFile = path.join(DEST_DIR, `.cudnn-${version}`);

  if (fs.existsSync(markerFile) && !process.argv.includes("--force")) {
    console.log(`[cudnn] cuDNN ${version} already downloaded (use --force to re-download)`);
    return;
  }

  const url = INDEX_URL + tarName;
  console.log(`[cudnn] Latest: ${tarName}`);
  console.log(`[cudnn] Downloading from ${url}`);

  const tempDir = path.join(os.tmpdir(), `openwhispr-cudnn-${Date.now()}`);
  const tarPath = path.join(tempDir, "cudnn.tar.xz");

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await downloadFile(url, tarPath);

    const stats = fs.statSync(tarPath);
    console.log(`[cudnn] Downloaded (${(stats.size / 1024 / 1024).toFixed(0)}MB)`);

    console.log("[cudnn] Extracting shared libraries...");
    execSync(`tar xf "${tarPath}" --wildcards '*/lib/libcudnn*.so*' -C "${tempDir}"`, {
      stdio: "pipe",
    });

    const extractedDir = fs.readdirSync(tempDir).find((d) => d.startsWith("cudnn-"));
    if (!extractedDir) throw new Error("Extraction failed: no cudnn directory found");

    const libDir = path.join(tempDir, extractedDir, "lib");
    const soFiles = fs.readdirSync(libDir).filter((f) => f.includes(".so"));

    if (fs.existsSync(DEST_DIR)) {
      fs.rmSync(DEST_DIR, { recursive: true });
    }
    fs.mkdirSync(DEST_DIR, { recursive: true });

    let totalSize = 0;
    for (const soFile of soFiles) {
      const src = path.join(libDir, soFile);
      const dest = path.join(DEST_DIR, soFile);
      const srcStat = fs.lstatSync(src);

      if (srcStat.isSymbolicLink()) {
        const target = fs.readlinkSync(src);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.symlinkSync(target, dest);
      } else {
        fs.copyFileSync(src, dest);
        totalSize += srcStat.size;
      }
    }

    fs.writeFileSync(markerFile, new Date().toISOString());

    console.log(`[cudnn] Installed ${soFiles.length} files (${(totalSize / 1024 / 1024).toFixed(0)}MB) to ${DEST_DIR}`);
    console.log(`[cudnn] cuDNN ${version} ready\n`);
  } catch (error) {
    console.error(`[cudnn] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

main();
