const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
} = require("./downloadUtils");
const { getSafeTempDir } = require("./safeTempDir");

const GITHUB_RELEASE_URL = "https://api.github.com/repos/OpenWhispr/whisper.cpp/releases/latest";

const PLATFORM_BINARY_NAMES = {
  linux: "whisper-server-linux-x64-cuda",
  win32: "whisper-server-win32-x64-cuda.exe",
};

const PLATFORM_ASSET_NAMES = {
  linux: "whisper-server-linux-x64-cuda.zip",
  win32: "whisper-server-win32-x64-cuda.zip",
};

const COMPANION_PATTERNS = {
  linux: /\.so(\.\d+)*$/,
  win32: /\.dll$/i,
};

function isSupportedPlatform() {
  return process.platform === "linux" || process.platform === "win32";
}

class WhisperCudaManager {
  constructor() {
    this._binDir = null;
    this._downloadSignal = null;
  }

  getCudaBinaryDir() {
    if (!this._binDir) {
      this._binDir = path.join(app.getPath("userData"), "bin");
      fs.mkdirSync(this._binDir, { recursive: true });
    }
    return this._binDir;
  }

  getCudaBinaryPath() {
    if (!isSupportedPlatform()) return null;

    const binaryName = PLATFORM_BINARY_NAMES[process.platform];
    const binaryPath = path.join(this.getCudaBinaryDir(), binaryName);
    return fs.existsSync(binaryPath) ? binaryPath : null;
  }

  isDownloaded() {
    return !!this.getCudaBinaryPath();
  }

  async fetchReleaseInfo() {
    if (!isSupportedPlatform()) {
      throw new Error(`CUDA binaries not available for ${process.platform}`);
    }

    const release = await this._fetchJson(GITHUB_RELEASE_URL);
    const assetName = PLATFORM_ASSET_NAMES[process.platform];
    const asset = release.assets?.find((a) => a.name === assetName);

    if (!asset) {
      throw new Error(`No CUDA asset found for ${process.platform} (expected ${assetName})`);
    }

    return {
      url: asset.browser_download_url,
      size: asset.size,
      version: release.tag_name,
    };
  }

  async download(progressCallback) {
    if (!isSupportedPlatform()) {
      throw new Error(`CUDA binaries not available for ${process.platform}`);
    }

    const releaseInfo = await this.fetchReleaseInfo();
    debugLogger.info("CUDA binary download starting", {
      version: releaseInfo.version,
      size: releaseInfo.size,
    });

    const binDir = this.getCudaBinaryDir();

    const spaceCheck = await checkDiskSpace(binDir, releaseInfo.size * 2);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space. Need ~${Math.round((releaseInfo.size * 2) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    await cleanupStaleDownloads(binDir);

    const { signal, abort } = createDownloadSignal();
    this._downloadSignal = { abort };

    const tempDir = getSafeTempDir();
    const zipPath = path.join(tempDir, `cuda-download-${Date.now()}.zip`);
    const extractDir = path.join(tempDir, `temp-extract-${Date.now()}`);

    try {
      await downloadFile(releaseInfo.url, zipPath, {
        timeout: 600000,
        signal,
        expectedSize: releaseInfo.size,
        onProgress: (downloaded, total) => {
          if (progressCallback) {
            progressCallback({
              type: "progress",
              downloaded_bytes: downloaded,
              total_bytes: total,
              percentage: total > 0 ? Math.round((downloaded / total) * 100) : 0,
            });
          }
        },
      });

      await fsPromises.mkdir(extractDir, { recursive: true });
      await this._extractZip(zipPath, extractDir);

      const binaryName = PLATFORM_BINARY_NAMES[process.platform];
      const companionPattern = COMPANION_PATTERNS[process.platform];
      const entries = await fsPromises.readdir(extractDir);

      for (const entry of entries) {
        if (entry === binaryName || companionPattern.test(entry)) {
          const src = path.join(extractDir, entry);
          const dest = path.join(binDir, entry);
          await fsPromises.copyFile(src, dest);

          if (process.platform === "linux") {
            await fsPromises.chmod(dest, 0o755);
          }
        }
      }

      if (!this.getCudaBinaryPath()) {
        throw new Error(`Extraction completed but binary "${binaryName}" not found in archive`);
      }

      debugLogger.info("CUDA binary download complete", {
        version: releaseInfo.version,
        path: this.getCudaBinaryPath(),
      });

      if (progressCallback) {
        progressCallback({ type: "complete", percentage: 100 });
      }
    } catch (error) {
      if (error.isAbort) {
        throw new Error("Download cancelled by user");
      }
      throw error;
    } finally {
      this._downloadSignal = null;
      await fsPromises.unlink(zipPath).catch(() => {});
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      this._downloadSignal = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async delete() {
    if (!isSupportedPlatform()) {
      return { success: false, error: "Not supported on this platform" };
    }

    const binDir = this.getCudaBinaryDir();
    const binaryName = PLATFORM_BINARY_NAMES[process.platform];
    const companionPattern = COMPANION_PATTERNS[process.platform];

    let deletedCount = 0;
    let freedBytes = 0;

    try {
      const entries = await fsPromises.readdir(binDir);

      for (const entry of entries) {
        if (entry === binaryName || companionPattern.test(entry)) {
          const filePath = path.join(binDir, entry);
          try {
            const stats = await fsPromises.stat(filePath);
            await fsPromises.unlink(filePath);
            freedBytes += stats.size;
            deletedCount++;
          } catch {
            // Continue with remaining files
          }
        }
      }
    } catch {
      // Directory may not exist
    }

    debugLogger.info("CUDA binary deleted", { deletedCount, freedBytes });

    return {
      success: deletedCount > 0,
      deleted_count: deletedCount,
      freed_bytes: freedBytes,
      freed_mb: Math.round(freedBytes / (1024 * 1024)),
    };
  }

  _fetchJson(url) {
    return new Promise((resolve, reject) => {
      https
        .get(
          url,
          {
            headers: {
              "User-Agent": "OpenWhispr/1.0",
              Accept: "application/vnd.github+json",
            },
            timeout: 15000,
          },
          (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
              const location = res.headers.location;
              if (!location) {
                reject(new Error("Redirect without location header"));
                return;
              }
              res.resume();
              this._fetchJson(location).then(resolve, reject);
              return;
            }

            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
              return;
            }

            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(new Error(`Failed to parse GitHub API response: ${e.message}`));
              }
            });
            res.on("error", reject);
          }
        )
        .on("error", reject)
        .on("timeout", function () {
          this.destroy();
          reject(new Error("GitHub API request timed out"));
        });
    });
  }

  _extractZip(zipPath, destDir) {
    if (process.platform === "win32") {
      return new Promise((resolve, reject) => {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
          ],
          (error) => {
            if (error) reject(new Error(`Zip extraction failed: ${error.message}`));
            else resolve();
          }
        );
      });
    }

    return new Promise((resolve, reject) => {
      execFile("unzip", ["-o", zipPath, "-d", destDir], (error) => {
        if (error) reject(new Error(`Zip extraction failed: ${error.message}`));
        else resolve();
      });
    });
  }
}

module.exports = WhisperCudaManager;
