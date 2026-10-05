const fs = require("fs");
const { promises: fsPromises } = require("fs");
const { createHash } = require("crypto");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  fetchJson,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
  extractArchive,
  findFile,
  findFiles,
} = require("./downloadUtils");
const { getSafeTempDir } = require("./safeTempDir");

const DISK_SPACE_MULTIPLIER = 2.5;
const FALLBACK_ASSET_SIZE = 100_000_000;

function githubReleaseHeaders() {
  const headers = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function getMissingRequiredLibraries(directory, assetConfig) {
  return (assetConfig.requiredLibraries || []).filter(
    (library) => !fs.existsSync(path.join(directory, library))
  );
}

// Shared download/install pipeline for GPU server binaries fetched from GitHub
// releases (whisper CUDA, whisper Vulkan, llama Vulkan). Subclasses configure
// the release URL, a dirName, and per-`${platform}-${arch}` assets (exact
// assetName or assetPattern regex; optional libPattern for companion libs and
// requiredLibraries for companions that must be present in a complete pack).
// Archives are sha256-verified against expectedDigests, falling back to the
// digest the GitHub API reports.
//
// Each pack installs into its own `userData/bin/<dirName>/` directory: the
// packs ship identically-named ggml DLLs, so a shared directory lets one
// pack's install silently overwrite another's runtime (and one pack's delete
// remove another's libs). The directory is staged next to its final location
// and swapped in with a single rename, so a crash or power loss mid-install
// can never leave a truncated binary that isDownloaded() reports as installed.
class GpuBinaryManager {
  constructor(config) {
    this.config = config;
    this._downloadSignal = null;
    this._downloading = false;
  }

  get binRoot() {
    return path.join(app.getPath("userData"), "bin");
  }

  get binDir() {
    return path.join(this.binRoot, this.config.dirName);
  }

  _getAssetConfig() {
    return this.config.assets[`${process.platform}-${process.arch}`] || null;
  }

  isSupported() {
    return this._getAssetConfig() !== null;
  }

  getBinaryPath() {
    const assetConfig = this._getAssetConfig();
    if (!assetConfig) return null;
    const binaryPath = path.join(this.binDir, assetConfig.outputName);
    try {
      if (!fs.existsSync(binaryPath)) return null;
      if (getMissingRequiredLibraries(this.binDir, assetConfig).length === 0) return binaryPath;
    } catch {}
    return null;
  }

  isDownloaded() {
    return this.getBinaryPath() !== null;
  }

  isDownloading() {
    return this._downloading;
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      downloaded: this.isDownloaded(),
      downloading: this._downloading,
    };
  }

  async _resolveAsset(assetConfig) {
    const release = await fetchJson(this.config.releaseUrl, { headers: githubReleaseHeaders() });
    if (!release?.assets) throw new Error(`Could not fetch ${this.config.name} release info`);

    const asset = release.assets.find((a) =>
      assetConfig.assetName
        ? a.name === assetConfig.assetName
        : assetConfig.assetPattern.test(a.name)
    );
    if (!asset) {
      throw new Error(
        `No ${this.config.name} asset found in release` +
          (assetConfig.assetName ? ` (expected ${assetConfig.assetName})` : "")
      );
    }
    return { asset, version: release.tag_name };
  }

  // The binaries are unsigned and release assets are mutable — fail closed on mismatch
  async _verifyDigest(asset, archivePath) {
    const pinned = this.config.expectedDigests?.[asset.name];
    const expected = pinned || (asset.digest || "").replace(/^sha256:/, "");
    if (!expected) return;

    const actual = await sha256File(archivePath);
    if (actual !== expected) {
      throw new Error(
        `${this.config.name} download failed integrity check ` +
          `(sha256 ${actual}, expected ${expected})`
      );
    }
  }

  async download(onProgress) {
    if (this._downloading) throw new Error("Download already in progress");
    const assetConfig = this._getAssetConfig();
    if (!assetConfig) {
      throw new Error(
        `${this.config.name} binaries not available for ${process.platform}-${process.arch}`
      );
    }

    this._downloading = true;
    const { signal, abort } = createDownloadSignal();
    this._downloadSignal = { abort };

    const tempDir = getSafeTempDir();
    let archivePath = null;
    let extractDir = null;
    let stagingDir = null;

    try {
      await fsPromises.mkdir(this.binRoot, { recursive: true });
      await cleanupStaleDownloads(this.binRoot);

      const { asset, version } = await this._resolveAsset(assetConfig);

      const requiredBytes = (asset.size || FALLBACK_ASSET_SIZE) * DISK_SPACE_MULTIPLIER;
      const spaceCheck = await checkDiskSpace(this.binRoot, requiredBytes);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space. Need ~${Math.round(requiredBytes / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      debugLogger.info(`${this.config.name} binary download starting`, {
        version,
        asset: asset.name,
        size: asset.size,
      });

      archivePath = path.join(tempDir, asset.name);
      extractDir = path.join(tempDir, `temp-extract-${Date.now()}`);

      await downloadFile(asset.browser_download_url, archivePath, {
        signal,
        expectedSize: asset.size,
        onProgress,
      });

      await this._verifyDigest(asset, archivePath);

      await fsPromises.mkdir(extractDir, { recursive: true });
      await extractArchive(archivePath, extractDir);

      const binaryPath = await findFile(extractDir, assetConfig.binaryName);
      if (!binaryPath) throw new Error(`${assetConfig.binaryName} not found in archive`);

      // Stage the complete pack beside its final directory (same volume), then
      // swap it in with one rename. The prefix keeps cleanupStaleDownloads able
      // to reap a staging dir orphaned by a crash.
      stagingDir = path.join(this.binRoot, `temp-extract-stage-${this.config.dirName}`);
      await fsPromises.rm(stagingDir, { recursive: true, force: true });
      await fsPromises.mkdir(stagingDir, { recursive: true });

      const outputPath = path.join(stagingDir, assetConfig.outputName);
      await fsPromises.copyFile(binaryPath, outputPath);
      if (process.platform !== "win32") await fsPromises.chmod(outputPath, 0o755);

      if (assetConfig.libPattern) {
        const libs = await findFiles(extractDir, assetConfig.libPattern);
        for (const lib of libs) {
          const dest = path.join(stagingDir, path.basename(lib));
          await fsPromises.copyFile(lib, dest);
          if (process.platform !== "win32") await fsPromises.chmod(dest, 0o755);
        }
      }

      const missingLibraries = getMissingRequiredLibraries(stagingDir, assetConfig);
      if (missingLibraries.length > 0) {
        throw new Error(
          `${this.config.name} archive is missing required libraries: ${missingLibraries.join(", ")}`
        );
      }

      await fsPromises.rm(this.binDir, { recursive: true, force: true });
      await fsPromises.rename(stagingDir, this.binDir);
      stagingDir = null;

      debugLogger.info(`${this.config.name} binary installed`, { version, path: this.binDir });
      return { version };
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
      if (archivePath) await fsPromises.unlink(archivePath).catch(() => {});
      if (extractDir) {
        await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }
      if (stagingDir) {
        await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      this._downloadSignal = null;
      return true;
    }
    return false;
  }

  async delete() {
    if (!this._getAssetConfig()) return { deletedCount: 0, freedBytes: 0 };

    let deletedCount = 0;
    let freedBytes = 0;

    try {
      const entries = await fsPromises.readdir(this.binDir);
      for (const entry of entries) {
        try {
          const stats = await fsPromises.stat(path.join(this.binDir, entry));
          freedBytes += stats.size;
          deletedCount++;
        } catch {
          // Still deleted with the directory below
        }
      }
      await fsPromises.rm(this.binDir, { recursive: true, force: true });
    } catch {
      // Pack directory may not exist
    }

    debugLogger.info(`${this.config.name} binary deleted`, { deletedCount, freedBytes });
    return { deletedCount, freedBytes };
  }
}

// One-time healing of the pre-subdirectory layout, where every pack installed
// directly into userData/bin and their identically-named ggml DLLs overwrote
// each other. A pack without companion libs is just moved into its directory.
// A pack with libs can't tell which of the surviving DLLs are its own (the
// clobbering destroyed that), so its files are removed and the pack shows as
// not installed until re-downloaded from Settings. Synchronous so it completes
// before startup pre-warm reads any binary path. Returns the names of the
// packs that were cleared so the caller can tell the user to re-download
// them instead of leaving a silent CPU fallback (#1606).
function migrateLegacyBinDir(managers) {
  const clearedPacks = [];
  const packs = managers
    .map((m) => ({ manager: m, assetConfig: m._getAssetConfig() }))
    .filter((p) => p.assetConfig);
  if (packs.length === 0) return clearedPacks;

  const binRoot = packs[0].manager.binRoot;
  if (!fs.existsSync(binRoot)) return clearedPacks;

  for (const { manager, assetConfig } of packs) {
    const legacyBinary = path.join(binRoot, assetConfig.outputName);
    try {
      if (!fs.existsSync(legacyBinary)) continue;
      if (assetConfig.libPattern) {
        fs.unlinkSync(legacyBinary);
        clearedPacks.push(manager.config.name);
        debugLogger.info(`${manager.config.name} legacy install removed (needs re-download)`);
      } else if (manager.isDownloaded()) {
        fs.unlinkSync(legacyBinary);
      } else {
        fs.mkdirSync(manager.binDir, { recursive: true });
        fs.renameSync(legacyBinary, path.join(manager.binDir, assetConfig.outputName));
        debugLogger.info(`${manager.config.name} migrated`, { to: manager.binDir });
      }
    } catch (err) {
      debugLogger.warn(`${manager.config.name} legacy migration failed`, { error: err.message });
    }
  }

  // The lib-carrying packs' orphaned companion libs (ownership is unknowable)
  const libPatterns = packs.map((p) => p.assetConfig.libPattern).filter(Boolean);
  if (libPatterns.length === 0) return clearedPacks;
  try {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !libPatterns.some((pattern) => pattern.test(entry.name))) continue;
      try {
        fs.unlinkSync(path.join(binRoot, entry.name));
      } catch {}
    }
  } catch {}
  return clearedPacks;
}

// An enabled flag with no pack on disk is only reachable via data loss (the
// 1.8.3 migrateLegacyBinDir deleted lib-carrying packs without recording a
// notice): the flag is only set after a completed download, and intentional
// deletes clear it. Returns the affected pack names for the re-download
// notice; callers must gate re-recording (gpuPackMigrationNotice.recordOnce)
// so a dismissed notice doesn't return every launch.
function detectOrphanedGpuPacks(packs) {
  return packs
    .filter(
      ({ manager, enabledEnvVar }) =>
        process.env[enabledEnvVar] === "true" && manager.isSupported() && !manager.isDownloaded()
    )
    .map(({ manager }) => manager.config.name);
}

module.exports = GpuBinaryManager;
module.exports.migrateLegacyBinDir = migrateLegacyBinDir;
module.exports.detectOrphanedGpuPacks = detectOrphanedGpuPacks;
