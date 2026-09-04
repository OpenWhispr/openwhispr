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

const WINDOWS_MSVC_RUNTIME_LIBRARIES = [
  "msvcp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcomp140.dll",
];

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

// CUDA pins real release digests, which a stubbed archive can never hash to. Tests that
// exercise shared pipeline behavior rather than integrity drop the pin to reach it.
function cudaManagerWithoutDigestPin() {
  const manager = new WhisperCudaManager();
  manager.config.expectedDigests = undefined;
  return manager;
}

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

function requiredLibrariesManager() {
  return new GpuBinaryManager({
    name: "test",
    dirName: "test-pack",
    releaseUrl: "https://api.github.com/repos/x/y/releases/latest",
    assets: {
      "linux-x64": {
        assetName: "bin.zip",
        binaryName: "server",
        outputName: "server-out",
        libPattern: /\.dll$/i,
        requiredLibraries: ["msvcp140.dll", "vcruntime140.dll"],
      },
    },
  });
}

function useWindowsAsset(manager) {
  const windowsAsset = manager.config.assets["win32-x64"];
  manager._getAssetConfig = () => windowsAsset;
  return manager;
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

test("CUDA: resolves its exact asset from the pinned tag and installs binary + companion libs", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = {
    "whisper-server-linux-x64-cuda": "binary",
    "libggml-cuda.so": "lib",
    "README.md": "doc",
  };

  const manager = cudaManagerWithoutDigestPin();
  await manager.download();

  assert.match(state.fetchedUrls[0], /OpenWhispr\/whisper\.cpp\/releases\/tags\/0\.0\.10$/);
  assert.equal(state.downloads[0].url, "https://dl/whisper-server-linux-x64-cuda.zip");

  const binDir = path.join(userDataDir, "bin", "whisper-cuda");
  const binaryPath = path.join(binDir, "whisper-server-linux-x64-cuda");
  assert.ok(fs.existsSync(binaryPath));
  assert.ok(fs.statSync(binaryPath).mode & 0o100, "binary is executable");
  assert.ok(fs.existsSync(path.join(binDir, "libggml-cuda.so")), "companion lib copied");
  assert.ok(!fs.existsSync(path.join(binDir, "README.md")), "unrelated files not copied");
  assert.equal(manager.getCudaBinaryPath(), binaryPath);
  assert.equal(manager.isDownloaded(), true);
  assert.equal(
    fs.readdirSync(path.join(userDataDir, "bin")).some((e) => e.startsWith("temp-extract-stage-")),
    false,
    "staging dir swapped away"
  );
});

test("llama Vulkan: resolves asset by regex from the pinned tag", async () => {
  state.release = makeRelease("llama-b9763-bin-ubuntu-vulkan-x64.tar.gz");
  state.extractedFiles = { "llama-server": "binary", "libvulkan.so.1": "lib" };

  const manager = new LlamaVulkanManager();
  const result = await manager.download();

  assert.deepEqual(result, { success: true });
  assert.match(state.fetchedUrls[0], /ggml-org\/llama\.cpp\/releases\/tags\/b9763$/);
  const packDir = path.join(userDataDir, "bin", "llama-vulkan");
  assert.ok(fs.existsSync(path.join(packDir, "llama-server-vulkan")), "renamed output");
  assert.ok(fs.existsSync(path.join(packDir, "libvulkan.so.1")));
});

test("CUDA: pinned digest rejects an asset that doesn't match (fail closed)", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = { "whisper-server-linux-x64-cuda": "binary" };

  await assert.rejects(() => new WhisperCudaManager().download(), { message: /integrity check/ });
  assert.equal(new WhisperCudaManager().isDownloaded(), false);
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
    dirName: "test-pack",
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
  assert.ok(fs.existsSync(path.join(userDataDir, "bin", "test-pack", "server-out")));

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

  const manager = cudaManagerWithoutDigestPin();
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

  const manager = cudaManagerWithoutDigestPin();
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

function seedPack(dirName, files) {
  const dir = path.join(userDataDir, "bin", dirName);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), "x");
  return dir;
}

test("delete: removes only the pack's own directory; other packs untouched", async () => {
  const cudaDir = seedPack("whisper-cuda", ["whisper-server-linux-x64-cuda", "libggml-cuda.so"]);
  const llamaDir = seedPack("llama-vulkan", ["llama-server-vulkan", "libggml-base.so"]);
  const vulkanDir = seedPack("whisper-vulkan", ["whisper-server-linux-x64-vulkan"]);

  const cudaResult = await new WhisperCudaManager().delete();
  assert.equal(cudaResult.success, true);
  assert.equal(cudaResult.deleted_count, 2);
  assert.ok(!fs.existsSync(cudaDir), "own pack directory removed");
  assert.ok(fs.existsSync(path.join(llamaDir, "libggml-base.so")), "other packs' libs untouched");

  const vulkanResult = await new WhisperVulkanManager().delete();
  assert.equal(vulkanResult.deletedCount, 1);
  assert.ok(!fs.existsSync(vulkanDir));

  const llamaResult = await new LlamaVulkanManager().deleteBinary();
  assert.deepEqual(llamaResult, { success: true, deletedCount: 2 });
});

test("install isolation: packs sharing lib names cannot clobber each other", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = { "whisper-server-linux-x64-cuda": "bin", "libggml-base.so": "cuda-ggml" };
  await cudaManagerWithoutDigestPin().download();

  state.release = makeRelease("llama-b9763-bin-ubuntu-vulkan-x64.tar.gz");
  state.extractedFiles = { "llama-server": "bin", "libggml-base.so": "llama-ggml" };
  await new LlamaVulkanManager().download();

  const read = (dir) =>
    fs.readFileSync(path.join(userDataDir, "bin", dir, "libggml-base.so"), "utf8");
  assert.equal(read("whisper-cuda"), "cuda-ggml");
  assert.equal(read("llama-vulkan"), "llama-ggml");
});

test("atomic install: a failure after extraction leaves no half-installed pack", async () => {
  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = { "not-the-binary": "x" };

  const manager = cudaManagerWithoutDigestPin();
  await assert.rejects(() => manager.download(), { message: /not found in archive/ });

  assert.equal(manager.isDownloaded(), false);
  assert.ok(!fs.existsSync(path.join(userDataDir, "bin", "whisper-cuda")));
  assert.equal(
    fs.readdirSync(path.join(userDataDir, "bin")).some((e) => e.startsWith("temp-extract-stage-")),
    false,
    "staging dir cleaned up"
  );
});

test("required libraries: a cached pack is incomplete when a required library is missing", () => {
  const manager = requiredLibrariesManager();
  const packDir = seedPack("test-pack", ["server-out"]);

  assert.equal(manager.isDownloaded(), false);

  fs.writeFileSync(path.join(packDir, "msvcp140.dll"), "runtime");
  assert.equal(manager.isDownloaded(), false);

  fs.writeFileSync(path.join(packDir, "vcruntime140.dll"), "runtime");
  assert.equal(manager.isDownloaded(), true);

  fs.unlinkSync(path.join(packDir, "msvcp140.dll"));
  assert.equal(manager.isDownloaded(), false);
});

test("required libraries: an incomplete archive cannot replace a working pack", async () => {
  const packDir = seedPack("test-pack", [
    "server-out",
    "msvcp140.dll",
    "vcruntime140.dll",
  ]);
  fs.writeFileSync(path.join(packDir, "server-out"), "working-binary");

  state.release = makeRelease("bin.zip");
  state.extractedFiles = {
    server: "new-binary",
    "msvcp140.dll": "new-runtime",
  };

  const manager = requiredLibrariesManager();
  await assert.rejects(() => manager.download(), {
    message: /missing required libraries: vcruntime140\.dll/,
  });

  assert.equal(fs.readFileSync(path.join(packDir, "server-out"), "utf8"), "working-binary");
  assert.equal(manager.isDownloaded(), true);
});

test("Windows whisper GPU packs require every app-local MSVC runtime library", () => {
  const managers = [
    useWindowsAsset(new WhisperCudaManager()),
    useWindowsAsset(new WhisperVulkanManager()),
  ];

  for (const manager of managers) {
    const assetConfig = manager._getAssetConfig();
    const packDir = seedPack(manager.config.dirName, [assetConfig.outputName]);

    assert.equal(manager.isDownloaded(), false, `${manager.config.name} rejects a bare exe`);

    for (const library of WINDOWS_MSVC_RUNTIME_LIBRARIES.slice(0, -1)) {
      fs.writeFileSync(path.join(packDir, library), "runtime");
    }
    assert.equal(manager.isDownloaded(), false, `${manager.config.name} rejects a partial runtime`);

    fs.writeFileSync(path.join(packDir, "vcomp140.dll"), "runtime");
    assert.equal(manager.isDownloaded(), true, `${manager.config.name} accepts the complete pack`);
  }
});

test("Windows whisper Vulkan installs the MSVC runtime libraries from its release archive", async () => {
  const manager = useWindowsAsset(new WhisperVulkanManager());
  manager.config.expectedDigests = undefined;
  const assetConfig = manager._getAssetConfig();

  state.release = makeRelease(assetConfig.assetName);
  state.extractedFiles = {
    [assetConfig.binaryName]: "binary",
    "msvcp140.dll": "runtime",
    "vcruntime140.dll": "runtime",
    "vcruntime140_1.dll": "runtime",
    "vcomp140.dll": "runtime",
  };

  await manager.download();

  assert.equal(manager.isDownloaded(), true);
  for (const library of WINDOWS_MSVC_RUNTIME_LIBRARIES) {
    assert.ok(fs.existsSync(path.join(manager.binDir, library)), `${library} copied`);
  }
});

test("re-download replaces the previous install, including stale libs", async () => {
  seedPack("whisper-cuda", ["whisper-server-linux-x64-cuda", "libstale.so"]);

  state.release = makeRelease("whisper-server-linux-x64-cuda.zip");
  state.extractedFiles = { "whisper-server-linux-x64-cuda": "new", "libggml-cuda.so": "lib" };
  await cudaManagerWithoutDigestPin().download();

  const packDir = path.join(userDataDir, "bin", "whisper-cuda");
  assert.deepEqual(fs.readdirSync(packDir).sort(), [
    "libggml-cuda.so",
    "whisper-server-linux-x64-cuda",
  ]);
});

test("legacy migration: lib-free pack is moved, lib-carrying packs are cleared for re-download", () => {
  const { migrateLegacyBinDir } = GpuBinaryManager;
  const binRoot = path.join(userDataDir, "bin");
  fs.mkdirSync(binRoot, { recursive: true });
  const seed = (name) => fs.writeFileSync(path.join(binRoot, name), "x");
  // Pre-subdirectory flat layout: both lib-carrying packs plus whisper Vulkan
  seed("whisper-server-linux-x64-cuda");
  seed("whisper-server-linux-x64-vulkan");
  seed("llama-server-vulkan");
  seed("libggml-base.so"); // clobbered shared lib — owner unknowable
  seed("libvulkan.so.1");

  const cuda = new WhisperCudaManager();
  const vulkan = new WhisperVulkanManager();
  const llama = new LlamaVulkanManager();
  const clearedPacks = migrateLegacyBinDir([cuda, vulkan, llama]);

  assert.equal(vulkan.isDownloaded(), true, "statically-linked pack migrated in place");
  assert.ok(fs.existsSync(path.join(binRoot, "whisper-vulkan", "whisper-server-linux-x64-vulkan")));
  assert.equal(cuda.isDownloaded(), false, "ambiguous pack needs re-download");
  assert.equal(llama.isDownloaded(), false);
  assert.deepEqual(
    fs.readdirSync(binRoot).sort(),
    ["whisper-vulkan"],
    "legacy binaries and orphaned libs removed"
  );
  assert.deepEqual(
    clearedPacks,
    ["CUDA whisper", "Vulkan llama"],
    "cleared (not migrated) packs are reported for the re-download notice"
  );

  // Idempotent on the healed layout — and nothing left to report
  assert.deepEqual(migrateLegacyBinDir([cuda, vulkan, llama]), []);
  assert.equal(vulkan.isDownloaded(), true);
});

test("legacy migration: win32 Vulkan without the 0.0.10 DLLs is cleared for re-download", () => {
  const { migrateLegacyBinDir } = GpuBinaryManager;
  const manager = useWindowsAsset(new WhisperVulkanManager());
  const windowsAsset = manager._getAssetConfig();

  const binRoot = path.join(userDataDir, "bin");
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(binRoot, windowsAsset.outputName), "binary");

  assert.deepEqual(migrateLegacyBinDir([manager]), ["Vulkan whisper"]);
  assert.equal(manager.isDownloaded(), false);
  assert.ok(!fs.existsSync(path.join(binRoot, windowsAsset.outputName)));
});

test("orphan detection: enabled flag with no pack on disk is reported for the notice", () => {
  const { detectOrphanedGpuPacks } = GpuBinaryManager;
  const packs = [
    { manager: new WhisperCudaManager(), enabledEnvVar: "WHISPER_CUDA_ENABLED" },
    { manager: new WhisperVulkanManager(), enabledEnvVar: "WHISPER_VULKAN_ENABLED" },
  ];

  try {
    // User never enabled GPU (missing flag) — nothing reported
    assert.deepEqual(detectOrphanedGpuPacks(packs), []);

    process.env.WHISPER_CUDA_ENABLED = "true";
    process.env.WHISPER_VULKAN_ENABLED = "false";
    assert.deepEqual(detectOrphanedGpuPacks(packs), ["CUDA whisper"]);

    // Pack present on disk — enabled but not orphaned
    seedPack("whisper-cuda", ["whisper-server-linux-x64-cuda"]);
    assert.deepEqual(detectOrphanedGpuPacks(packs), []);

    process.env.WHISPER_VULKAN_ENABLED = "true";
    assert.deepEqual(detectOrphanedGpuPacks(packs), ["Vulkan whisper"]);

    // The lib-carrying llama Vulkan pack (also deleted by the 1.8.3
    // migration) is detected through the same shape
    const llamaPacks = [
      { manager: new LlamaVulkanManager(), enabledEnvVar: "LLAMA_VULKAN_ENABLED" },
    ];
    assert.deepEqual(detectOrphanedGpuPacks(llamaPacks), []);
    process.env.LLAMA_VULKAN_ENABLED = "true";
    assert.deepEqual(detectOrphanedGpuPacks(llamaPacks), ["Vulkan llama"]);
    seedPack("llama-vulkan", ["llama-server-vulkan"]);
    assert.deepEqual(detectOrphanedGpuPacks(llamaPacks), []);

    // Unsupported platform can't re-download the pack — never reported
    const unsupported = new GpuBinaryManager({ name: "none", dirName: "none", assets: {} });
    process.env.NONE_ENABLED = "true";
    assert.deepEqual(
      detectOrphanedGpuPacks([{ manager: unsupported, enabledEnvVar: "NONE_ENABLED" }]),
      []
    );
  } finally {
    delete process.env.WHISPER_CUDA_ENABLED;
    delete process.env.WHISPER_VULKAN_ENABLED;
    delete process.env.LLAMA_VULKAN_ENABLED;
    delete process.env.NONE_ENABLED;
  }
});

test("getStatus reflects supported/downloaded/downloading", async () => {
  const manager = new WhisperVulkanManager();
  assert.deepEqual(manager.getStatus(), {
    supported: true,
    downloaded: false,
    downloading: false,
  });

  seedPack("whisper-vulkan", ["whisper-server-linux-x64-vulkan"]);
  assert.equal(manager.getStatus().downloaded, true);
});
