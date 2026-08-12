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

// Shared download/install pipeline for GPU server binaries fetched from GitHub
// releases (whisper CUDA, whisper Vulkan, llama Vulkan). Subclasses configure
// the release URL and per-`${platform}-${arch}` assets (exact assetName or
// assetPattern regex; optional libPattern for companion libs). Archives are
// sha256-verified against expectedDigests, falling back to the digest the
// GitHub API reports.
class GpuBinaryManager {
  constructor(config) {
    this.config = config;
    this._binDir = null;
    this._downloadSignal = null;
    this._downloading = false;
  }

  get binDir() {
    if (!this._binDir) {
      this._binDir = path.join(app.getPath("userData"), "bin");
    }
    return this._binDir;
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
      if (fs.existsSync(binaryPath)) return binaryPath;
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

    try {
      await fsPromises.mkdir(this.binDir, { recursive: true });
      await cleanupStaleDownloads(this.binDir);

      const { asset, version } = await this._resolveAsset(assetConfig);

      const requiredBytes = (asset.size || FALLBACK_ASSET_SIZE) * DISK_SPACE_MULTIPLIER;
      const spaceCheck = await checkDiskSpace(this.binDir, requiredBytes);
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

      const outputPath = path.join(this.binDir, assetConfig.outputName);
      await fsPromises.copyFile(binaryPath, outputPath);
      if (process.platform !== "win32") await fsPromises.chmod(outputPath, 0o755);

      if (assetConfig.libPattern) {
        const libs = await findFiles(extractDir, assetConfig.libPattern);
        for (const lib of libs) {
          const dest = path.join(this.binDir, path.basename(lib));
          await fsPromises.copyFile(lib, dest);
          if (process.platform !== "win32") await fsPromises.chmod(dest, 0o755);
        }
      }

      debugLogger.info(`${this.config.name} binary installed`, { version, path: outputPath });
      return { version };
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
      if (archivePath) await fsPromises.unlink(archivePath).catch(() => {});
      if (extractDir) {
        await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
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
    const assetConfig = this._getAssetConfig();
    if (!assetConfig) return { deletedCount: 0, freedBytes: 0 };

    let deletedCount = 0;
    let freedBytes = 0;

    try {
      const entries = await fsPromises.readdir(this.binDir);
      for (const entry of entries) {
        if (entry !== assetConfig.outputName && !assetConfig.libPattern?.test(entry)) continue;
        const filePath = path.join(this.binDir, entry);
        try {
          const stats = await fsPromises.stat(filePath);
          await fsPromises.unlink(filePath);
          freedBytes += stats.size;
          deletedCount++;
        } catch {
          // Continue with remaining files
        }
      }
    } catch {
      // Directory may not exist
    }

    debugLogger.info(`${this.config.name} binary deleted`, { deletedCount, freedBytes });
    return { deletedCount, freedBytes };
  }
}

module.exports = GpuBinaryManager;
