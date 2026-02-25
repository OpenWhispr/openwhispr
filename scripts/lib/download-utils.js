const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_REDIRECTS = 5;

/**
 * Fetch JSON from a URL with proper error handling.
 * @param {string} url - URL to fetch
 * @param {number} [redirectCount=0] - Current redirect count (internal use)
 * @returns {Promise<object>} - Parsed JSON response
 */
function fetchJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const headers = {
      "User-Agent": "OpenWhispr-Downloader",
      Accept: "application/vnd.github+json",
    };

    // Use GitHub token if available (increases rate limit from 60 to 5000/hour)
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      headers,
      timeout: REQUEST_TIMEOUT,
    };

    https
      .get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error("Redirect without location header"));
            return;
          }
          fetchJson(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Request timeout")));
  });
}

/**
 * Fetch the latest release from a GitHub repository.
 * @param {string} repo - Repository in "owner/repo" format
 * @param {object} options - Options
 * @param {string} [options.tagPrefix] - Only match releases with this tag prefix (e.g., "windows-key-listener-v")
 * @param {boolean} [options.includePrerelease=false] - Include prerelease versions
 * @returns {Promise<{tag: string, assets: Array<{name: string, url: string}>, url: string} | null>}
 */
async function fetchLatestRelease(repo, options = {}) {
  const { tagPrefix, includePrerelease = false } = options;

  try {
    // If no tag prefix, use the simple /latest endpoint
    if (!tagPrefix) {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const release = await fetchJson(url);
      return formatRelease(release);
    }

    // Otherwise, fetch all releases and filter by prefix
    const url = `https://api.github.com/repos/${repo}/releases?per_page=50`;
    const releases = await fetchJson(url);

    if (!Array.isArray(releases)) {
      return null;
    }

    // Find the latest release matching the prefix
    for (const release of releases) {
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;
      if (release.tag_name && release.tag_name.startsWith(tagPrefix)) {
        return formatRelease(release);
      }
    }

    return null;
  } catch (error) {
    console.error(`  Failed to fetch latest release for ${repo}: ${error.message}`);
    return null;
  }
}

/**
 * Format a GitHub release response into a simplified object.
 * @param {object} release - GitHub release API response
 * @returns {{tag: string, assets: Array<{name: string, url: string}>, url: string}}
 */
function formatRelease(release) {
  return {
    tag: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFile(url, dest, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let activeRequest = null;

    const cleanup = () => {
      if (activeRequest) {
        activeRequest.destroy();
        activeRequest = null;
      }
      file.close();
    };

    const request = (currentUrl, redirectCount = 0) => {
      if (redirectCount > MAX_REDIRECTS) {
        cleanup();
        reject(new Error("Too many redirects"));
        return;
      }

      activeRequest = https.get(currentUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            cleanup();
            reject(new Error("Redirect without location header"));
            return;
          }
          request(redirectUrl, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"], 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          const pct = total ? Math.round((downloaded / total) * 100) : 0;
          process.stdout.write(`\r  Downloading: ${pct}%`);
        });

        response.on("error", (err) => {
          cleanup();
          reject(err);
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log(" Done");
          resolve();
        });

        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      activeRequest.on("error", (err) => {
        cleanup();
        reject(err);
      });

      activeRequest.setTimeout(REQUEST_TIMEOUT, () => {
        cleanup();
        reject(new Error("Connection timed out"));
      });
    };

    request(url);
  }).catch(async (error) => {
    const isTransient =
      error.message.includes("timed out") ||
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT";

    if (isTransient && retryCount < MAX_RETRIES) {
      console.log(`\n  Retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
      await sleep(RETRY_DELAY);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return downloadFile(url, dest, retryCount + 1);
    }
    throw error;
  });
}

async function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    // Use unzipper package on Windows for better path handling
    const unzipper = require("unzipper");
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  }
}

function extractTarGz(tarPath, destDir) {
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: "inherit" });
}

async function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    extractTarGz(archivePath, destDir);
  } else {
    await extractZip(archivePath, destDir);
  }
}

function findBinaryInDir(dir, binaryName, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName, maxDepth, currentDepth + 1);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }

  return null;
}

function parseArgs() {
  const args = process.argv;
  let targetPlatform = process.env.TARGET_PLATFORM || process.platform;
  let targetArch = process.env.TARGET_ARCH || process.arch;

  // CLI args override env vars
  const platformIndex = args.indexOf("--platform");
  if (platformIndex !== -1 && args[platformIndex + 1]) {
    targetPlatform = args[platformIndex + 1];
  }

  const archIndex = args.indexOf("--arch");
  if (archIndex !== -1 && args[archIndex + 1]) {
    targetArch = args[archIndex + 1];
  }

  return {
    targetPlatform,
    targetArch,
    platformArch: `${targetPlatform}-${targetArch}`,
    isCurrent: args.includes("--current"),
    isAll: args.includes("--all"),
    isForce: args.includes("--force"),
    shouldCleanup:
      args.includes("--clean") ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true",
  };
}

function setExecutable(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

function cleanupFiles(binDir, prefix, keepPrefix) {
  const files = fs.readdirSync(binDir).filter((f) => f.startsWith(prefix));
  files.forEach((file) => {
    if (!file.startsWith(keepPrefix)) {
      const filePath = path.join(binDir, file);
      console.log(`Removing old binary: ${file}`);
      fs.unlinkSync(filePath);
    }
  });
}

module.exports = {
  downloadFile,
  extractArchive,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
};
