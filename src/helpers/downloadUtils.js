const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const { net } = require("electron");
const { execFile } = require("child_process");
const { pipeline } = require("stream");
const debugLogger = require("./debugLogger");

const USER_AGENT = "OpenWhispr/1.0";
const PROGRESS_THROTTLE_MS = 100;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;
const STALL_TIMEOUT_MS = 30000;
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_DOWNLOAD_INCOMPLETE",
]);

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

function isTlsError(error) {
  return (
    TLS_ERROR_CODES.has(error.code) ||
    (error.message && error.message.includes("unable to get local issuer certificate"))
  );
}

function isRetryable(error) {
  if (error.isAbort || error.isHttpError || isTlsError(error)) return false;
  return RETRYABLE_CODES.has(error.code);
}

function headerValue(headers, name) {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function backoffDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadAttempt(url, tempPath, options) {
  const { onProgress, signal, startOffset = 0, expectedSize = 0, _redirects = 0 } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      return;
    }

    if (_redirects > MAX_REDIRECTS) {
      reject(Object.assign(new Error("Too many redirects"), { isHttpError: true }));
      return;
    }

    const headers = { "User-Agent": USER_AGENT };
    if (startOffset > 0) {
      headers["Range"] = `bytes=${startOffset}-`;
    }

    let request = null;
    let activeFile = null;
    let stallTimer = null;
    let downloadedSize = startOffset;
    let totalSize = 0;
    let lastProgressUpdate = 0;

    const cleanup = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (request) {
        request.abort();
        request = null;
      }
      if (activeFile) {
        activeFile.destroy();
        activeFile = null;
      }
    };

    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
    };

    if (signal) {
      signal.onAbort = onAbort;
    }

    // Manual redirects so we can reset startOffset when the new origin ignores Range.
    request = net.request({ url, method: "GET", redirect: "manual" });
    for (const [name, value] of Object.entries(headers)) {
      request.setHeader(name, value);
    }

    request.on("response", (response) => {
      if (signal?.aborted) {
        response.resume();
        cleanup();
        reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
        return;
      }

      const statusCode = response.statusCode;

      if (statusCode >= 300 && statusCode < 400) {
        response.resume();
        if (signal) signal.onAbort = null;
        if (request) {
          request.abort();
          request = null;
        }
        const redirectUrl = headerValue(response.headers, "location");
        if (!redirectUrl) {
          reject(
            Object.assign(new Error("Redirect without location header"), { isHttpError: true })
          );
          return;
        }
        downloadAttempt(redirectUrl, tempPath, { ...options, _redirects: _redirects + 1 }).then(
          resolve,
          reject
        );
        return;
      }

      // Content response — create write stream
      if (statusCode === 200 && startOffset > 0) {
        // Server doesn't support Range — restart from beginning
        downloadedSize = 0;
        activeFile = fs.createWriteStream(tempPath, { flags: "w" });
        totalSize = parseInt(headerValue(response.headers, "content-length"), 10) || 0;
      } else if (statusCode === 206) {
        activeFile = fs.createWriteStream(tempPath, { flags: "a" });
        const contentRange = headerValue(response.headers, "content-range");
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
        if (!totalSize) {
          const contentLength = parseInt(headerValue(response.headers, "content-length"), 10) || 0;
          totalSize = startOffset + contentLength;
        }
      } else if (statusCode === 200) {
        activeFile = fs.createWriteStream(tempPath, { flags: "w" });
        totalSize = parseInt(headerValue(response.headers, "content-length"), 10) || 0;
      } else {
        response.resume();
        cleanup();
        const err = new Error(`HTTP ${statusCode}`);
        err.isHttpError = true;
        err.statusCode = statusCode;
        reject(err);
        return;
      }

      // Fall back to caller-provided expected size when Content-Length is missing
      if (totalSize <= 0 && expectedSize > 0) {
        totalSize = expectedSize;
      }

      const resetStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          cleanup();
          reject(
            Object.assign(new Error("Download stalled — no data received for 30s"), {
              code: "ETIMEDOUT",
            })
          );
        }, STALL_TIMEOUT_MS);
      };

      resetStallTimer();

      response.on("data", (chunk) => {
        if (signal?.aborted) {
          cleanup();
          return;
        }
        downloadedSize += chunk.length;
        resetStallTimer();
        emitProgress();
      });

      pipeline(response, activeFile, (err) => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (signal) signal.onAbort = null;
        if (err) {
          if (signal?.aborted) {
            reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
          } else {
            reject(err);
          }
        } else if (totalSize > 0 && downloadedSize < totalSize) {
          reject(
            Object.assign(
              new Error(`Download incomplete: received ${downloadedSize} of ${totalSize} bytes`),
              { code: "ERR_DOWNLOAD_INCOMPLETE" }
            )
          );
        } else {
          resolve({ downloadedSize, totalSize });
        }
      });
    });

    request.on("error", (err) => {
      if (signal) signal.onAbort = null;
      cleanup();
      if (signal?.aborted) {
        reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      } else if (isTlsError(err)) {
        reject(
          Object.assign(new Error(`Certificate error: ${err.message}`), {
            code: "TLS_ERROR",
            isTlsError: true,
          })
        );
      } else {
        reject(err);
      }
    });

    request.end();

    function emitProgress() {
      if (!onProgress) return;
      const now = Date.now();
      if (
        now - lastProgressUpdate >= PROGRESS_THROTTLE_MS ||
        (totalSize > 0 && downloadedSize >= totalSize)
      ) {
        lastProgressUpdate = now;
        onProgress(downloadedSize, totalSize);
      }
    }
  });
}

async function downloadFile(url, destPath, options = {}) {
  const { onProgress, maxRetries = DEFAULT_MAX_RETRIES, signal, expectedSize = 0 } = options;

  const tempPath = `${destPath}.tmp`;

  debugLogger.info("Download starting", { url, destPath });

  let startOffset = 0;
  try {
    const stats = await fsPromises.stat(tempPath);
    if (stats.size > 0) {
      startOffset = stats.size;
      debugLogger.info("Resuming download", { startOffset });
    }
  } catch {
    // No existing temp file
  }

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    }

    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      debugLogger.info("Retrying download", { attempt, delay, startOffset });
      await sleep(delay);

      // Update startOffset from temp file in case partial data was written
      try {
        const stats = await fsPromises.stat(tempPath);
        if (stats.size > 0) startOffset = stats.size;
      } catch {
        startOffset = 0;
      }
    }

    try {
      await downloadAttempt(url, tempPath, {
        onProgress,
        signal,
        startOffset,
        expectedSize,
      });

      // Atomic move to final path
      try {
        await fsPromises.rename(tempPath, destPath);
      } catch (renameError) {
        if (renameError.code === "EXDEV") {
          await fsPromises.copyFile(tempPath, destPath);
          await fsPromises.unlink(tempPath).catch(() => {});
        } else {
          throw renameError;
        }
      }

      debugLogger.info("Download complete", { destPath });
      return destPath;
    } catch (error) {
      lastError = error;

      if (error.isAbort) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
      }

      if (!isRetryable(error) || attempt >= maxRetries) {
        debugLogger.error("Download failed", {
          url,
          error: error.message,
          code: error.code,
        });
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
      }

      debugLogger.warn("Download attempt failed", {
        attempt: attempt + 1,
        error: error.message,
        code: error.code,
      });
    }
  }

  debugLogger.error("Download failed after all retries", {
    url,
    error: lastError?.message,
    code: lastError?.code,
  });
  await fsPromises.unlink(tempPath).catch(() => {});
  throw lastError;
}

function createDownloadSignal() {
  const signal = { aborted: false, onAbort: null };
  return {
    signal,
    abort() {
      signal.aborted = true;
      if (typeof signal.onAbort === "function") {
        signal.onAbort();
      }
    },
  };
}

async function validateFileSize(filePath, expectedSizeBytes, tolerancePercent = 10) {
  const stats = await fsPromises.stat(filePath);
  const minSize = expectedSizeBytes * (1 - tolerancePercent / 100);
  if (stats.size < minSize) {
    await fsPromises.unlink(filePath).catch(() => {});
    throw Object.assign(
      new Error(
        `Download appears corrupted: file is ${Math.round(stats.size / 1_000_000)}MB, ` +
          `expected at least ${Math.round(minSize / 1_000_000)}MB`
      ),
      { code: "ERR_FILE_TOO_SMALL" }
    );
  }
  return stats.size;
}

async function cleanupStaleDownloads(directory) {
  try {
    const entries = await fsPromises.readdir(directory);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".tmp") && !entry.startsWith("temp-extract-")) continue;
      const fullPath = path.join(directory, entry);
      try {
        const stats = await fsPromises.stat(fullPath);
        if (now - stats.mtimeMs > STALE_TMP_AGE_MS) {
          if (stats.isDirectory()) {
            await fsPromises.rm(fullPath, { recursive: true, force: true });
          } else {
            await fsPromises.unlink(fullPath);
          }
          debugLogger.info("Cleaned up stale download artifact", { path: fullPath });
        }
      } catch {
        // Skip files we can't stat or delete
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

async function checkDiskSpace(directory, requiredBytes) {
  try {
    const stats = await fsPromises.statfs(directory);
    const availableBytes = stats.bavail * stats.bsize;
    return { ok: availableBytes >= requiredBytes, availableBytes };
  } catch {
    // statfs not supported or directory doesn't exist — skip check
    return { ok: true, availableBytes: Infinity };
  }
}

function extractZipWindows(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xf", zipPath, "-C", destDir], (error) => {
      if (error) {
        debugLogger.info("tar extraction failed, trying PowerShell", { error: error.message });
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
          ],
          (psError) => {
            if (psError) reject(new Error(`Zip extraction failed: ${psError.message}`));
            else resolve();
          }
        );
      } else {
        resolve();
      }
    });
  });
}

function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    return new Promise((resolve, reject) => {
      execFile("tar", ["-xzf", archivePath, "-C", destDir], (err) => {
        err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve();
      });
    });
  }

  if (process.platform === "win32") {
    return extractZipWindows(archivePath, destDir);
  }

  return new Promise((resolve, reject) => {
    execFile("unzip", ["-o", archivePath, "-d", destDir], (err) => {
      err ? reject(new Error(`Extraction failed: ${err.message}`)) : resolve();
    });
  });
}

async function findFile(dir, name, maxDepth = 5, depth = 0) {
  if (depth >= maxDepth) return null;
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, name, maxDepth, depth + 1);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

async function findFiles(dir, pattern, maxDepth = 5, depth = 0) {
  if (depth >= maxDepth) return [];
  const results = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFiles(full, pattern, maxDepth, depth + 1)));
    } else if (pattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

module.exports = {
  downloadFile,
  createDownloadSignal,
  validateFileSize,
  cleanupStaleDownloads,
  checkDiskSpace,
  extractArchive,
  findFile,
  findFiles,
};
