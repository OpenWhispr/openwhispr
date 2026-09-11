const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const LlamaServerManager = require("../../src/helpers/llamaServer.js");

// A manager whose spawn is stubbed at the _doStart boundary, recording the
// options each start was asked for.
function makeManager() {
  const manager = new LlamaServerManager();
  const starts = [];
  manager._doStart = async (modelPath, options = {}) => {
    manager.ready = true;
    manager.modelPath = modelPath;
    manager.draftModelPath = options.draftModelPath || null;
    starts.push({ modelPath, contextSize: options.contextSize });
  };
  return { manager, starts };
}

// --- grow-only restart ---------------------------------------------------
//
// Before #2142 the context was a single constant, so start() could ignore
// options entirely once a server was ready. Now that the context varies per
// request, it has to restart to grow — but only to grow, or a long note
// followed by a short dictation would restart the server twice.

test("a larger context restarts the server", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 16384 });
  assert.equal(starts.length, 1);

  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 32768);
});

test("an equal or smaller context reuses the running server", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 1);

  // Exactly the same → no restart.
  await manager.start("/models/main.gguf", { contextSize: 32768 });
  assert.equal(starts.length, 1);

  // Smaller → no restart, and the larger window is kept. This is what stops a
  // short dictation right after a long note from costing a second restart.
  await manager.start("/models/main.gguf", { contextSize: 16384 });
  assert.equal(starts.length, 1);
  assert.equal(manager.contextSize, 32768);
});

test("growing the context still restarts when the drafter is unchanged", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/main.gguf", { contextSize: 16384, draftModelPath: "/d.gguf" });
  await manager.start("/models/main.gguf", { contextSize: 65536, draftModelPath: "/d.gguf" });

  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 65536);
});

test("a context grown for one model does not carry over to another", async () => {
  const { manager, starts } = makeManager();

  await manager.start("/models/big.gguf", { contextSize: 65536 });
  await manager.start("/models/other.gguf", { contextSize: 16384 });

  assert.equal(starts.length, 2);
  assert.equal(manager.contextSize, 16384, "the new model starts at its own size");
});

test("stopping the server forgets the grown context", async () => {
  const { manager } = makeManager();
  manager._killCurrentProcess = async () => {};
  manager.process = {};

  await manager.start("/models/main.gguf", { contextSize: 65536 });
  assert.equal(manager.contextSize, 65536);

  await manager.stop();
  assert.equal(manager.contextSize, null);
});

// --- spawn arguments -----------------------------------------------------

test("every GPU ladder rung inherits the requested context and cache bounds", async () => {
  const manager = new LlamaServerManager();
  const seen = [];
  manager._buildEnv = () => ({});
  manager._killCurrentProcess = async () => {};
  manager.findAvailablePort = async () => 8221;
  manager.draftModelPath = null;
  manager._startWithBinary = async (binary, args) => {
    seen.push(args);
    throw new Error("stub fail");
  };

  const baseArgs = manager._buildBaseArgs("/models/main.gguf", 8221, {
    contextSize: 32768,
    cacheRamMiB: 1024,
  });
  await assert.rejects(() =>
    manager._startWithGpuFallback({ vulkan: "/bin/vulkan", cpu: "/bin/cpu" }, baseArgs, {}, [])
  );

  assert.ok(seen.length >= 2, "expected the ladder to try more than one rung");
  for (const args of seen) {
    assert.equal(args[args.indexOf("--ctx-size") + 1], "32768");
    // llama-server defaults --cache-ram to 8192 MiB of host RAM on top of the
    // KV cache. Left unbounded it would undo the memory budget entirely.
    assert.equal(args[args.indexOf("--cache-ram") + 1], "1024");
  }
});

// --- context-overflow errors --------------------------------------------

test("a context overflow is reported as a typed error, not as llama.cpp JSON", async () => {
  const overflowBody = JSON.stringify({
    error: {
      code: 400,
      message: "request (20514 tokens) exceeds the available context size (16384 tokens)",
      type: "exceed_context_size_error",
      n_prompt_tokens: 20514,
      n_ctx: 16384,
    },
  });

  const server = http.createServer((req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(overflowBody);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const manager = new LlamaServerManager();
  manager.ready = true;
  manager.process = {};
  manager.port = server.address().port;

  try {
    await assert.rejects(
      () => manager.inference([{ role: "user", content: "hi" }], {}),
      (error) => {
        assert.equal(error.code, "CONTEXT_TOO_LARGE");
        assert.equal(error.neededTokens, 20514);
        assert.equal(error.maxContextTokens, 16384);
        // The whole point: a customer must never be shown a JSON blob.
        assert.ok(!error.message.includes("{"), `raw JSON leaked: ${error.message}`);
        return true;
      }
    );
  } finally {
    manager.clearIdleTimer();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("other llama-server failures keep their existing shape", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const manager = new LlamaServerManager();
  manager.ready = true;
  manager.process = {};
  manager.port = server.address().port;

  try {
    await assert.rejects(
      () => manager.inference([{ role: "user", content: "hi" }], {}),
      (error) => {
        assert.equal(error.code, undefined);
        assert.match(error.message, /llama-server returned status 500/);
        return true;
      }
    );
  } finally {
    manager.clearIdleTimer();
    await new Promise((resolve) => server.close(resolve));
  }
});
