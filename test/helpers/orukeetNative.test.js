const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const OrukeetNative = require("../../src/helpers/orukeetNative");
const registry = require("../../src/models/modelRegistryData.json");

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orukeet-fallback-"));
  const modelName = "orukeet-unit-fixture";
  const bytes = Buffer.from("unit model integrity fixture");
  const oldDevice = process.env.OPENWHISPR_ORUKEET_DEVICE;
  delete process.env.OPENWHISPR_ORUKEET_DEVICE;
  registry.parakeetModels[modelName] = {
    engine: "nemo-speech",
    fileName: "fixture.gguf",
    expectedSizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const worker = new OrukeetNative();
  worker.warmup = async () => {};
  worker.prepareRuntime = async (candidate) => candidate;
  worker.getGPUInfo = async () => null;
  worker.getRuntimeCandidates = () => ["cuda", "vulkan", "cpu"].map((device) => ({ device }));
  await fs.writeFile(path.join(root, "fixture.gguf"), bytes);
  try {
    await run(worker, modelName, root);
  } finally {
    await worker.stop();
    delete registry.parakeetModels[modelName];
    if (oldDevice === undefined) delete process.env.OPENWHISPR_ORUKEET_DEVICE;
    else process.env.OPENWHISPR_ORUKEET_DEVICE = oldDevice;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("automatic startup falls back through isolated GPU workers and remembers failures", async () => {
  await fixture(async (worker, model, dir) => {
    const attempts = [];
    worker._startWorker = async ({ device }, modelName) => {
      attempts.push(device);
      if (device !== "cpu") throw new Error("driver unavailable");
      worker.ready = true;
      worker.modelName = modelName;
      worker.runtime = { device, protocol_version: 1 };
    };
    await worker.start(model, dir);
    assert.deepEqual(attempts, ["cuda", "vulkan", "cpu"]);
    assert.equal(worker.getStatus().transport, "file");
    await worker.start(model, dir);
    assert.equal(attempts.length, 3);
    await worker.stop();
    await worker.start(model, dir);
    assert.deepEqual(attempts, ["cuda", "vulkan", "cpu", "cpu"]);
  });
});

test("an explicit GPU selection never silently changes to CPU", async () => {
  await fixture(async (worker, model, dir) => {
    process.env.OPENWHISPR_ORUKEET_DEVICE = "cuda";
    const attempts = [];
    worker._startWorker = async ({ device }) => {
      attempts.push(device);
      throw new Error("driver unavailable");
    };
    await assert.rejects(worker.start(model, dir), /driver unavailable/);
    assert.deepEqual(attempts, ["cuda"]);
  });
});

test("cancelling startup does not start a fallback worker", async () => {
  await fixture(async (worker, model, dir) => {
    let entered, release;
    const called = new Promise((resolve) => {
      entered = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const attempts = [];
    worker._startWorker = async ({ device }) => {
      attempts.push(device);
      entered();
      await held;
      throw new Error("load interrupted");
    };
    const starting = worker.start(model, dir);
    await called;
    await worker.stop();
    release();
    await assert.rejects(starting, { name: "AbortError" });
    assert.deepEqual(attempts, ["cuda"]);
  });
});

test("model corruption fails before any hardware attempt", async () => {
  await fixture(async (worker, model, dir) => {
    worker._startWorker = async () => assert.fail("must not spawn");
    await fs.writeFile(path.join(dir, "fixture.gguf"), "bad");
    await assert.rejects(worker.start(model, dir), /size mismatch/);
  });
});

test("a GPU that loads but fails decoding retries the same audio on a fallback", async () => {
  await fixture(async (worker, model, dir) => {
    const devices = [];
    worker._startWorker = async ({ device }, modelName) => {
      devices.push(device);
      worker.modelName = modelName;
      worker.ready = true;
      worker.runtime = { device, protocol_version: 1 };
    };
    const audio = Buffer.alloc(4);
    worker._transcribe = async (samples) => {
      assert.equal(samples, audio);
      if (worker.runtime.device !== "cpu") {
        const error = new Error("GPU failed on its first graph");
        error.workerFailure = true;
        throw error;
      }
      return { text: "recovered transcript" };
    };
    await worker.start(model, dir);
    assert.equal((await worker.transcribe(audio, 16000)).text, "recovered transcript");
    assert.deepEqual(devices, ["cuda", "vulkan", "cpu"]);
    assert.equal(worker.getStatus().fallbacks.length, 2);
  });
});

test("invalid audio does not disable a working GPU", async () => {
  await fixture(async (worker, model, dir) => {
    let starts = 0;
    worker._startWorker = async ({ device }, modelName) => {
      starts++;
      worker.modelName = modelName;
      worker.ready = true;
      worker.runtime = { device, protocol_version: 1 };
    };
    worker._transcribe = async () => {
      throw new Error("PCM samples must be finite");
    };
    await worker.start(model, dir);
    await assert.rejects(worker.transcribe(Buffer.alloc(4), 16000), /finite/);
    assert.equal(starts, 1);
    assert.equal(worker.failedDevices.size, 0);
  });
});
