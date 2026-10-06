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
    manager.ready = true;
  };
  const payloads = [];
  manager.on("cuda-fallback", (payload) => payloads.push(payload));

  t.after(async () => {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { manager, model, payloads };
}

test("a startup failure is proven once the same GPU setup has started this session", async (t) => {
  const { manager, model, payloads } = startupManager(t, [true, false, true]);
  const tiny = model("tiny");

  await manager._doStart(tiny, { useCuda: true });
  assert.equal(manager.startedGpuKeys.size, 1);

  await manager._doStart(tiny, { useCuda: true });

  assert.deepEqual(payloads, [{ proven: true }]);
  assert.equal(manager.useCuda, false);
  assert.equal(manager.gpuFallbackActive, true);
});

test("a startup failure of a GPU setup that never started is not proven", async (t) => {
  const { manager, model, payloads } = startupManager(t, [false, true]);

  await manager._doStart(model("tiny"), { useCuda: true });

  assert.deepEqual(payloads, [{ proven: false }]);
  // The CPU server that took over is not a GPU start
  assert.equal(manager.startedGpuKeys.size, 0);
});

test("a model that never started on the GPU is not proven by another one that did", async (t) => {
  // e.g. a bigger model that runs out of VRAM where a smaller one worked
  const { manager, model, payloads } = startupManager(t, [true, false, true]);

  await manager._doStart(model("tiny"), { useCuda: true });
  await manager._doStart(model("large"), { useCuda: true });

  assert.deepEqual(payloads, [{ proven: false }]);
});
