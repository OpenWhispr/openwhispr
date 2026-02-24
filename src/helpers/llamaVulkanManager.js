const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
} = require("./downloadUtils");

const GITHUB_RELEASE_URL = "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest";

const VULKAN_ASSETS = {
  "win32-x64": {
    assetPattern: /^llama-.*-bin-win-vulkan-x64\.zip$/,
    binaryName: "llama-server.exe",
    outputName: "llama-server-vulkan.exe",
    libPattern: /\.dll$/i,
  },
  "linux-x64": {
    assetPattern: /^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/,
    binaryName: "llama-server",
    outputName: "llama-server-vulkan",
    libPattern: /\.so(\.\d+)*$/,
  },
};

class LlamaVulkanManager {
  constructor() {
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

  _getConfig() {
    return VULKAN_ASSETS[`${process.platform}-${process.arch}`] || null;
  }

  isSupported() {
    return this._getConfig() !== null;
  }

  getBinaryPath() {
    const config = this._getConfig();
    if (!config) return null;
    const p = path.join(this.binDir, config.outputName);
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
    return null;
  }

  isDownloaded() {
    return this.getBinaryPath() !== null;
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      downloaded: this.isDownloaded(),
      downloading: this._downloading,
    };
  }

  async download(onProgress) {
    if (this._downloading) throw new Error("Download already in progress");
    if (!this.isSupported()) throw new Error("Vulkan not available for this platform");

    this._downloading = true;
    const { signal, abort } = createDownloadSignal();
    this._downloadSignal = { abort };

    try {
      await fsPromises.mkdir(this.binDir, { recursive: true });
      await cleanupStaleDownloads(this.binDir);

      const release = await this._fetchJson(GITHUB_RELEASE_URL);
      if (!release?.assets) throw new Error("Could not fetch llama.cpp release info");

      const config = this._getConfig();
      const asset = release.assets.find((a) => config.assetPattern.test(a.name));
      if (!asset) throw new Error("Vulkan binary not found in latest release");

      const spaceCheck = await checkDiskSpace(this.binDir, (asset.size || 100_000_000) * 2.5);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space. Need ~${Math.round(((asset.size || 100_000_000) * 2.5) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      const archivePath = path.join(this.binDir, asset.name);
      await downloadFile(asset.browser_download_url, archivePath, {
        signal,
        expectedSize: asset.size,
        onProgress,
      });

      const extractDir = path.join(this.binDir, `temp-vulkan-${Date.now()}`);
      await fsPromises.mkdir(extractDir, { recursive: true });

      try {
        await this._extract(archivePath, extractDir);

        const binaryPath = this._findFile(extractDir, config.binaryName);
        if (!binaryPath) throw new Error(`${config.binaryName} not found in archive`);

        const outputPath = path.join(this.binDir, config.outputName);
        await fsPromises.copyFile(binaryPath, outputPath);
        if (process.platform !== "win32") await fsPromises.chmod(outputPath, 0o755);

        const libs = this._findFiles(extractDir, config.libPattern);
        for (const lib of libs) {
          const dest = path.join(this.binDir, path.basename(lib));
          await fsPromises.copyFile(lib, dest);
          if (process.platform !== "win32") await fsPromises.chmod(dest, 0o755);
        }

        debugLogger.info("Vulkan llama-server installed", { path: outputPath });
      } finally {
        await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        await fsPromises.unlink(archivePath).catch(() => {});
      }

      return { success: true };
    } catch (error) {
      if (error.isAbort) return { success: false, cancelled: true };
      throw error;
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
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

  async deleteBinary() {
    const config = this._getConfig();
    if (!config) return { success: true };

    let deletedCount = 0;
    try {
      const entries = await fsPromises.readdir(this.binDir);
      for (const entry of entries) {
        if (entry === config.outputName || config.libPattern.test(entry)) {
          await fsPromises.unlink(path.join(this.binDir, entry)).catch(() => {});
          deletedCount++;
        }
      }
    } catch {}

    debugLogger.info("Vulkan llama-server deleted", { deletedCount });
    return { success: true, deletedCount };
  }

  _fetchJson(url) {
    const https = require("https");
    return new Promise((resolve, reject) => {
      const headers = {
        "User-Agent": "OpenWhispr/1.0",
        Accept: "application/vnd.github+json",
      };
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;

      https
        .get(url, { headers, timeout: 15000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            this._fetchJson(res.headers.location).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`GitHub API returned ${res.statusCode}`));
            return;
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error("Failed to parse GitHub release JSON"));
            }
          });
        })
        .on("error", reject);
    });
  }

  _extract(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
        execFile("tar", ["-xzf", archivePath, "-C", destDir], (err) => {
          err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve();
        });
      } else if (process.platform === "win32") {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`,
          ],
          (err) => {
            err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve();
          }
        );
      } else {
        execFile("unzip", ["-o", archivePath, "-d", destDir], (err) => {
          err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve();
        });
      }
    });
  }

  _findFile(dir, name, maxDepth = 5, depth = 0) {
    if (depth >= maxDepth) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this._findFile(full, name, maxDepth, depth + 1);
        if (found) return found;
      } else if (entry.name === name) {
        return full;
      }
    }
    return null;
  }

  _findFiles(dir, pattern, maxDepth = 5, depth = 0) {
    if (depth >= maxDepth) return [];
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this._findFiles(full, pattern, maxDepth, depth + 1));
      } else if (pattern.test(entry.name)) {
        results.push(full);
      }
    }
    return results;
  }
}

module.exports = LlamaVulkanManager;
