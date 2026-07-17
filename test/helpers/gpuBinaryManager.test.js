const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Characterization tests for the shared GPU binary download pipeline and the
// divergent cancel/delete semantics its wrappers preserve. Runs outside
// Electron: electron and the download/extract layer are stubbed before loading.

let userDataDir = null;
let tempDir = null;

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir } },
};
require.cache[require.resolve("../../src/helpers/safeTempDir.js")] = {
  exports: { getSafeTempDir: () => tempDir },
};

// Pin to linux-x64 so asset-config resolution behaves identically on any host
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "arch", { value: "x64" });

const state = {};

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else results.push(full);
  }
  return results;
}

require.cache[require.resolve("../../src/helpers/downloadUtils.js")] = {
  exports: {
    fetchJson: async (url) => {
      state.fetchedUrls.push(url);
      return state.release;
    },
    downloadFile: async (url, dest, opts) => {
      state.downloads.push({ url, dest, opts });
      await state.downloadImpl(url, dest, opts);
      return dest;
    },
    createDownloadSignal: () => {
      const signal = { aborted: false, onAbort: null };
      return {
        signal,
        abort() {
          signal.aborted = true;
          if (typeof signal.onAbort === "function") signal.onAbort();
        },
      };
    },
    checkDiskSpace: async () => state.diskSpace,
    cleanupStaleDownloads: async () => {},
    extractArchive: async (archivePath, destDir) => {
      state.extractDirs.push(destDir);
      await state.extractImpl(archivePath, destDir);
    },
    findFile: async (dir, name) => walk(dir).find((f) => path.basename(f) === name) || null,
    findFiles: async (dir, pattern) => walk(dir).filter((f) => pattern.test(path.basename(f))),
  },
};

const GpuBinaryManager = require("../../src/helpers/gpuBinaryManager.js");
const WhisperCudaManager = require("../../src/helpers/whisperCudaManager.js");
const LlamaVulkanManager = require("../../src/helpers/llamaVulkanManager.js");
const WhisperVulkanManager = require("../../src/helpers/whisperVulkanManager.js");

function makeRelease(assetName, overrides = {}) {
  return {
    tag_name: "test-tag",
    assets: [
      { name: "unrelated.txt", browser_download_url: "https://dl/unrelated", size: 1 },
      {
        name: assetName,
        browser_download_url: `https://dl/${assetName}`,
        size: 1000,
        ...overrides,
      },
    ],
  };
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpuBinaryManager-user-"));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpuBinaryManager-tmp-"));
  state.release = null;
  state.fetchedUrls = [];
  state.downloads = [];
  state.extractDirs = [];
  state.diskSpace = { ok: true, availableBytes: Infinity };
  state.archiveContent = "archive-bytes";
  state.downloadImpl = async (_url, dest) => fs.writeFileSync(dest, state.archiveContent);
  state.extractedFiles = {};
  state.extractImpl = async (_archivePath, destDir) => {
    for (const [name, content] of Object.entries(state.extractedFiles)) {
      fs.writeFileSync(path.join(destDir, name), content);
    }
  };
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("CUDA: resolves its exact asset from releases/latest and installs binary + companion libs", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = {
    "whisper-server-linux-x64-cuda": "binary",
    "libggml-cuda.so": "lib",
    "README.md": "doc",
  };

  const manager = new WhisperCudaManager();
  await manager.download();

  assert.match(state.fetchedUrls[0], /OpenWhispr\/whisper\.cpp\/releases\/latest$/);
  assert.equal(state.downloads[0].url, "https://dl/whisper-server-linux-x64-cuda.zip");

  const binDir = path.join(userDataDir, "bin");
  const binaryPath = path.join(binDir, "whisper-server-linux-x64-cuda");
  assert.ok(fs.existsSync(binaryPath));
  assert.ok(fs.statSync(binaryPath).mode & 0o100, "binary is executable");
  assert.ok(fs.existsSync(path.join(binDir, "libggml-cuda.so")), "companion lib copied");
  assert.ok(!fs.existsSync(path.join(binDir, "README.md")), "unrelated files not copied");
  assert.equal(manager.getCudaBinaryPath(), binaryPath);
  assert.equal(manager.isDownloaded(), true);
});

test("llama Vulkan: resolves asset by regex from the pinned tag", async () => {
  state.release = makeRelease("llama-b9763-bin-ubuntu-vulkan-x64.tar.gz");
  state.extractedFiles = { "llama-server": "binary", "libvulkan.so.1": "lib" };

  const manager = new LlamaVulkanManager();
  const result = await manager.download();

  assert.deepEqual(result, { success: true });
  assert.match(state.fetchedUrls[0], /ggml-org\/llama\.cpp\/releases\/tags\/b9763$/);
  assert.ok(fs.existsSync(path.join(userDataDir, "bin", "llama-server-vulkan")), "renamed output");
  assert.ok(fs.existsSync(path.join(userDataDir, "bin", "libvulkan.so.1")));
});

test("whisper Vulkan: pinned asset, no companion libs, rejects a digest mismatch (fail closed)", async () => {
  state.release = makeRelease("whisper-server-linux-x64-vulkan.zip");
  state.extractedFiles = { "whisper-server-linux-x64-vulkan": "binary" };

  const manager = new WhisperVulkanManager();
  await assert.rejects(() => manager.download(), { message: /integrity check/ });

  assert.equal(manager.isDownloaded(), false);
  assert.equal(state.extractDirs.length, 0, "mismatched archive is never extracted");
  const archivePath = path.join(tempDir, "whisper-server-linux-x64-vulkan.zip");
  assert.ok(!fs.existsSync(archivePath), "archive cleaned up after failure");
});

test("digest: pinned match installs; API-reported digest is the fallback and also fails closed", async () => {
  const config = (expectedDigests) => ({
    name: "test",
    releaseUrl: "https://api.github.com/repos/x/y/releases/latest",
    expectedDigests,
    assets: {
      "linux-x64": { assetName: "bin.zip", binaryName: "server", outputName: "server-out" },
    },
  });
  state.extractedFiles = { server: "binary" };
  const goodDigest = sha256(state.archiveContent);

  state.release = makeRelease("bin.zip");
  await new GpuBinaryManager(config({ "bin.zip": goodDigest })).download();
  assert.ok(fs.existsSync(path.join(userDataDir, "bin", "server-out")));

  state.release = makeRelease("bin.zip", { digest: `sha256:${goodDigest}` });
  await new GpuBinaryManager(config(undefined)).download();

  state.release = makeRelease("bin.zip", { digest: `sha256:${"0".repeat(64)}` });
  await assert.rejects(() => new GpuBinaryManager(config(undefined)).download(), {
    message: /integrity check/,
  });
});

test("progress: raw (downloaded, total) callback passes straight through", async () => {
  state.release = makeRelease("llama-b9763-bin-ubuntu-vulkan-x64.tar.gz");
  state.extractedFiles = { "llama-server": "binary" };
  state.downloadImpl = async (_url, dest, opts) => {
    opts.onProgress(50, 100);
    opts.onProgress(100, 100);
    fs.writeFileSync(dest, state.archiveContent);
  };

  const calls = [];
  await new LlamaVulkanManager().download((downloaded, total) => calls.push([downloaded, total]));
  assert.deepEqual(calls, [
    [50, 100],
    [100, 100],
  ]);
});

test("cancel semantics: CUDA throws, llama returns { cancelled: true }", async () => {
  const abortError = () => Object.assign(new Error("Download cancelled"), { isAbort: true });
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.downloadImpl = async () => {
    throw abortError();
  };
  await assert.rejects(() => new WhisperCudaManager().download(), {
    message: "Download cancelled by user",
  });

  state.release = makeRelease("llama-b9763-bin-ubuntu-vulkan-x64.tar.gz");
  const result = await new LlamaVulkanManager().download();
  assert.deepEqual(result, { success: false, cancelled: true });
});

test("cancelDownload aborts only when a download is active", async () => {
  const manager = new WhisperCudaManager();
  assert.deepEqual(await manager.cancelDownload(), {
    success: false,
    error: "No active download to cancel",
  });

  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  let abortedSignal = null;
  let releaseDownload;
  const gate = new Promise((resolve) => (releaseDownload = resolve));
  state.downloadImpl = async (_url, dest, opts) => {
    abortedSignal = opts.signal;
    await gate;
    if (opts.signal.aborted) {
      throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    }
    fs.writeFileSync(dest, state.archiveContent);
  };

  const downloadPromise = manager.download();
  while (!abortedSignal) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await manager.cancelDownload(), {
    success: true,
    message: "Download cancelled",
  });
  assert.equal(abortedSignal.aborted, true);
  releaseDownload();
  await assert.rejects(() => downloadPromise, { message: "Download cancelled by user" });
});

test("guard: a second download while one is in flight throws", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  let releaseDownload;
  const gate = new Promise((resolve) => (releaseDownload = resolve));
  state.downloadImpl = async (_url, dest) => {
    await gate;
    fs.writeFileSync(dest, state.archiveContent);
  };
  state.extractedFiles = { "whisper-server-linux-x64-cuda": "binary" };

  const manager = new WhisperCudaManager();
  const first = manager.download();
  await assert.rejects(() => manager.download(), { message: "Download already in progress" });
  releaseDownload();
  await first;
});

test("cleanup on failure: archive and extract dir removed, next download can start", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractImpl = async () => {
    throw new Error("Extraction failed: corrupt");
  };

  const manager = new WhisperCudaManager();
  await assert.rejects(() => manager.download(), { message: /Extraction failed/ });

  assert.equal(fs.readdirSync(tempDir).length, 0, "temp artifacts removed");
  assert.equal(manager.isDownloading(), false);

  state.extractImpl = async (_archivePath, destDir) => {
    fs.writeFileSync(path.join(destDir, "whisper-server-linux-x64-cuda"), "binary");
  };
  await manager.download();
  assert.equal(manager.isDownloaded(), true);
});

test("disk space: failure surfaces the friendly error with the 2.5x requirement", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip", { size: 100_000_000 });
  state.diskSpace = { ok: false, availableBytes: 5_000_000 };

  await assert.rejects(() => new WhisperCudaManager().download(), {
    message: "Not enough disk space. Need ~250MB, only 5MB available.",
  });
});

test("delete: removes binary + matching libs only; whisper Vulkan leaves shared DLL-space alone", async () => {
  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const seed = (name) => fs.writeFileSync(path.join(binDir, name), "x");
  seed("whisper-server-linux-x64-cuda");
  seed("libggml-cuda.so");
  seed("llama-server-vulkan");
  seed("whisper-server-linux-x64-vulkan");

  const cudaResult = await new WhisperCudaManager().delete();
  assert.equal(cudaResult.success, true);
  assert.equal(cudaResult.deleted_count, 2);
  assert.ok(!fs.existsSync(path.join(binDir, "whisper-server-linux-x64-cuda")));
  assert.ok(!fs.existsSync(path.join(binDir, "libggml-cuda.so")));
  assert.ok(fs.existsSync(path.join(binDir, "llama-server-vulkan")), "other backends untouched");

  const vulkanResult = await new WhisperVulkanManager().delete();
  assert.equal(vulkanResult.deletedCount, 1);
  assert.ok(!fs.existsSync(path.join(binDir, "whisper-server-linux-x64-vulkan")));

  const llamaResult = await new LlamaVulkanManager().deleteBinary();
  assert.deepEqual(llamaResult, { success: true, deletedCount: 1 });
});

test("getStatus reflects supported/downloaded/downloading", async () => {
  const manager = new WhisperVulkanManager();
  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: false,
    downloading: false,
  });

  const binDir = path.join(userDataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "whisper-server-linux-x64-vulkan"), "x");
  assert.equal(manager.getStatus().downloaded, true);
});
