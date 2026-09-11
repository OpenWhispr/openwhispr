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

// --- measuring the running server ----------------------------------------
//
// The estimate only picks the size the server starts at. These two calls are
// what make the decision exact: /props reports the window actually in force
// (which can differ from what we asked for), and /apply-template + /tokenize
// price the real prompt, chat template and all.

function withStubServer(routes) {
  return async (run) => {
    const server = http.createServer((req, res) => {
      const handler = routes[req.url];
      if (!handler) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const { status = 200, payload } = handler(body);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const manager = new LlamaServerManager();
    manager.ready = true;
    manager.process = {};
    manager.port = server.address().port;
    try {
      await run(manager);
    } finally {
      manager.clearIdleTimer();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test("usableContextSize reports the window the server actually has", async () => {
  await withStubServer({
    "/props": () => ({ payload: { default_generation_settings: { n_ctx: 32768 } } }),
  })(async (manager) => {
    assert.equal(await manager.usableContextSize(), 32768);
  });
});

test("usableContextSize returns null rather than guessing when props is unreadable", async () => {
  // A broken measurement must degrade to the estimate, never fail the request.
  await withStubServer({ "/props": () => ({ status: 500, payload: {} }) })(async (manager) => {
    assert.equal(await manager.usableContextSize(), null);
  });
  await withStubServer({})(async (manager) => {
    assert.equal(await manager.usableContextSize(), null);
  });
});

test("countPromptTokens prices the rendered template, not just the message text", async () => {
  let templatedWith = null;
  let tokenized = null;

  await withStubServer({
    "/apply-template": (body) => {
      templatedWith = JSON.parse(body);
      // The real server renders role tags and, with thinking disabled, an
      // empty <think></think> block. All of it costs context.
      return { payload: { prompt: "<|im_start|>system\nSYS<|im_end|>\nhello" } };
    },
    "/tokenize": (body) => {
      tokenized = JSON.parse(body);
      return { payload: { tokens: new Array(20514).fill(0) } };
    },
  })(async (manager) => {
    const messages = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
    ];
    assert.equal(await manager.countPromptTokens(messages, { disableThinking: true }), 20514);
    assert.deepEqual(templatedWith.messages, messages);
    assert.deepEqual(templatedWith.chat_template_kwargs, { enable_thinking: false });
    assert.equal(tokenized.content, "<|im_start|>system\nSYS<|im_end|>\nhello");
  });
});

test("countPromptTokens returns null when the server cannot measure", async () => {
  await withStubServer({ "/apply-template": () => ({ status: 500, payload: {} }) })(
    async (manager) => {
      assert.equal(await manager.countPromptTokens([{ role: "user", content: "hi" }], {}), null);
    }
  );
});
