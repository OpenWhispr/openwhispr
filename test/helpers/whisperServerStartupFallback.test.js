const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WhisperServerManager = require("../../src/helpers/whisperServer");

// The real _doStart, with Node standing in for the whisper-server binary (it
// exits at once on whisper's arguments) and waitForReady deciding each start's
// outcome. A GPU start that fails after the same backend, device and model
// already started this session is reported as proven: a GPU still waking from
// sleep, not one that can never work. #2265
function startupManager(t, outcomes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-startup-"));
  const model = (name) => {
    const modelPath = path.join(dir, `ggml-${name}.bin`);
    fs.writeFileSync(modelPath, "");
    return modelPath;
  };

  const manager = new WhisperServerManager();
  manager.getServerBinaryPath = () => process.execPath;
  manager.getFFmpegPath = () => null;
  manager.waitForReady = async () => {
    if (!outcomes.shift()) throw new Error("whisper-server process died during startup");
    // What a real GPU server logs once its backend is up; a GPU start without
    // it counts as a failure
    if (manager.useCuda || manager.useVulkan) {
      const backend = manager.useCuda ? "CUDA0" : "Vulkan0";
      manager.process.stderr.emit("data", `whisper_backend_init_gpu: using ${backend} backend\n`);
    }
    manager.ready = true;
  };
  const payloads = [];
  manager.on("cuda-fallback", (payload) => payloads.push(payload));
  const vulkanPayloads = [];
  manager.on("gpu-fallback", (payload) => vulkanPayloads.push(payload));

  t.after(async () => {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, model, payloads, vulkanPayloads };
}

test("a startup failure is proven once the same GPU setup has started this session", async (t) => {
  const { manager, model, payloads } = startupManager(t, [true, false, true]);
  const tiny = model("tiny");

  await manager._doStart(tiny, { useCuda: true });
  assert.equal(manager.startedGpuKeys.size, 1);

  // A wake re-warm stops the server before starting it again
  await manager.stop();
  await manager._doStart(tiny, { useCuda: true });

  assert.deepEqual(
    payloads.map(({ proven }) => proven),
    [true]
  );
  assert.equal(manager.useCuda, false);
  assert.equal(manager.gpuFallbackActive, true);
});

test("a startup failure of a GPU setup that never started is not proven", async (t) => {
  const { manager, model, payloads } = startupManager(t, [false, true]);

  await manager._doStart(model("tiny"), { useCuda: true });

  assert.deepEqual(
    payloads.map(({ proven }) => proven),
    [false]
  );
  // The CPU server that took over is not a GPU start
  assert.equal(manager.startedGpuKeys.size, 0);
});

test("a model that never started on the GPU is not proven by another one that did", async (t) => {
  // e.g. a bigger model that runs out of VRAM where a smaller one worked
  const { manager, model, payloads } = startupManager(t, [true, false, true]);

  await manager._doStart(model("tiny"), { useCuda: true });
  await manager._doStart(model("large"), { useCuda: true });

  assert.deepEqual(
    payloads.map(({ proven }) => proven),
    [false]
  );
});

test("the Vulkan step after a proven CUDA failure is proven too", async (t) => {
  // Both packs installed: Vulkan only runs when CUDA fails, so it never
  // started on its own, but it shares the GPU that is still waking up
  const { manager, model, payloads, vulkanPayloads } = startupManager(t, [
    true,
    false,
    false,
    true,
  ]);
  const tiny = model("tiny");

  await manager._doStart(tiny, { useCuda: true, fallbackToVulkan: true });
  await manager.stop();
  await manager._doStart(tiny, { useCuda: true, fallbackToVulkan: true });

  assert.deepEqual(
    payloads.map(({ fallbackBackend, proven }) => ({ fallbackBackend, proven })),
    [{ fallbackBackend: "vulkan", proven: true }]
  );
  assert.deepEqual(
    vulkanPayloads.map(({ fallbackBackend, proven }) => ({ fallbackBackend, proven })),
    [{ fallbackBackend: "cpu", proven: true }]
  );
});

test("the Vulkan step after an unproven CUDA failure is judged on its own", async (t) => {
  const { manager, model, payloads, vulkanPayloads } = startupManager(t, [false, false, true]);

  await manager._doStart(model("tiny"), { useCuda: true, fallbackToVulkan: true });

  assert.deepEqual(
    payloads.map(({ proven }) => proven),
    [false]
  );
  assert.deepEqual(
    vulkanPayloads.map(({ proven }) => proven),
    [false]
  );
});

test("a later start does not inherit a fallback's proof", async (t) => {
  const { manager, model } = startupManager(t, [true]);

  await manager._policyAllowedStart(model("tiny"), { useVulkan: true, cascadeProven: true });

  assert.equal(manager.useVulkan, true);
  assert.equal("cascadeProven" in manager.lastStartOptions, false);
});
