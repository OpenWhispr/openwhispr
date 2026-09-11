const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const { buildGguf, LLAMA_3_2_3B_ENTRIES } = require("./harness/ggufFixtures");

// Drives modelManagerBridge.runInference against a stub llama-server, to pin
// how the context window is chosen for a request (#2142). The model file on
// disk is a REAL GGUF header padded to a plausible size, so the ceiling is
// computed through the production path rather than from a fixture object.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadModelManager() {
  for (const modulePath of CHAIN_MODULES) delete require.cache[modulePath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          getAppPath: () => process.cwd(),
          getPath: (name) => (name === "home" ? electronHome : path.join(electronHome, name)),
        },
        net: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require("../../src/helpers/modelDirUtils.js");
    return require("../../src/helpers/modelManagerBridge.js").default;
  } finally {
    Module._load = originalLoad;
  }
}

const GIB = 1024 * 1024 * 1024;
const SHORT_PROMPT = "Clean up this sentence.";
// ~20k estimated tokens, the size that fails on main today.
const LONG_PROMPT = "word ".repeat(12000);

async function setup(t, { tokenCount = null, totalMemoryBytes = 48 * GIB } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-ctx-sizing-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const calls = { tokenize: 0, props: 0, completions: 0, template: 0 };
  // The completion body is where the output allowance actually lands, so tests
  // about it have to read the wire rather than the config object.
  let completionBody = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let status = 200;
      let payload;
      if (req.url === "/props") {
        calls.props += 1;
        payload = { default_generation_settings: { n_ctx: serverManager.contextSize } };
      } else if (req.url === "/apply-template") {
        calls.template += 1;
        payload = { prompt: "RENDERED" };
      } else if (req.url === "/tokenize") {
        calls.tokenize += 1;
        if (tokenCount === null) {
          status = 500;
          payload = {};
        } else {
          payload = { tokens: new Array(tokenCount).fill(0) };
        }
      } else {
        calls.completions += 1;
        completionBody = JSON.parse(raw);
        payload = { choices: [{ finish_reason: "stop", message: { content: "done" } }] };
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const modelManager = loadModelManager();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });

  // A valid GGUF header, padded past the minimum-size check.
  const header = buildGguf(LLAMA_3_2_3B_ENTRIES);
  await fs.writeFile(
    path.join(modelManager.modelsDir, model.fileName),
    Buffer.concat([header, Buffer.alloc(1_000_001, 1)])
  );

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  serverManager.contextSize = 16384;
  modelManager.currentServerModelId = model.id;
  modelManager._systemMemoryBytes = () => totalMemoryBytes;
  t.after(() => serverManager.clearIdleTimer());

  // Stand in for the spawn. The real _doStart leaves the manager ready on a
  // live port, so the stub must too, or the preflight would see a dead server.
  const restarts = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    restarts.push(options.contextSize);
    serverManager.ready = true;
    serverManager.process = {};
    serverManager.port = server.address().port;
  };
  // Avoid signalling a pid that does not belong to us; stop() itself is
  // covered in llamaServerContext.test.js.
  serverManager.stop = async () => {
    serverManager.ready = false;
    serverManager.process = null;
    serverManager.contextSize = null;
  };

  return {
    modelManager,
    modelId: model.id,
    calls,
    restarts,
    serverManager,
    completionBody: () => completionBody,
  };
}

test("a short request costs no measurement and no restart", async (t) => {
  // The dictation-cleanup invariant. Every dictation goes through this path;
  // adding a round trip or a restart here would be a far worse regression than
  // the bug being fixed.
  const { modelManager, modelId, calls, restarts, completionBody } = await setup(t, {
    tokenCount: 40,
  });

  const result = await modelManager.runInference(modelId, SHORT_PROMPT, {
    systemPrompt: "Clean up dictation.",
    maxTokens: 900,
  });

  assert.equal(result, "done");
  assert.equal(restarts.length, 0, "a short request must not restart the server");
  assert.equal(calls.tokenize, 0, "a short request must not pay for tokenization");
  assert.equal(calls.completions, 1);
  // A request that comfortably fits must reach the model with the allowance
  // the caller asked for. Without this, trimming everything to a stub would
  // still pass every other test in this file.
  assert.equal(completionBody().max_tokens, 900);
});

test("a long request grows the context once and then succeeds", async (t) => {
  const { modelManager, modelId, calls, restarts, serverManager } = await setup(t, {
    tokenCount: 20514, // the customer's measured prompt
  });

  const result = await modelManager.runInference(modelId, LONG_PROMPT, {
    systemPrompt: "Write meeting notes.",
  });

  assert.equal(result, "done");
  assert.deepEqual(restarts, [32768], "exactly one restart, onto the rung that fits");
  assert.equal(serverManager.contextSize, 32768);
  assert.equal(calls.completions, 1);
});

test("a request too large for the machine fails before it reaches the model", async (t) => {
  const { modelManager, modelId, calls } = await setup(t, { tokenCount: 200000 });

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => {
      assert.equal(error.code, "CONTEXT_TOO_LARGE");
      assert.ok(error.details.neededTokens >= 200000);
      assert.ok(error.details.maxContextTokens > 0);
      assert.ok(!error.message.includes("{"), `raw JSON leaked: ${error.message}`);
      return true;
    }
  );

  // Sending it anyway would burn minutes of prefill to earn a 400.
  assert.equal(calls.completions, 0, "must not send a request that cannot fit");
});

test("a broken measurement falls back to the estimate instead of failing the request", async (t) => {
  const { modelManager, modelId, calls } = await setup(t, { tokenCount: null }); // /tokenize 500s

  const result = await modelManager.runInference(modelId, LONG_PROMPT, {
    systemPrompt: "Write notes.",
  });

  assert.equal(result, "done");
  assert.ok(calls.tokenize > 0, "it should have tried to measure");
  assert.equal(calls.completions, 1, "and still completed on the estimate");
});

test("a short request after a long one reuses the grown context", async (t) => {
  const { modelManager, modelId, restarts } = await setup(t, { tokenCount: 20514 });

  await modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." });
  assert.deepEqual(restarts, [32768]);

  await modelManager.runInference(modelId, SHORT_PROMPT, { systemPrompt: "Clean up." });
  assert.deepEqual(restarts, [32768], "the short request must not shrink or restart the server");
});

test("a small machine refuses what a large one accepts, for the same request", async (t) => {
  // The #1203 guarantee, expressed end to end: the ceiling is a property of
  // the machine, so the same transcript is allowed on 48 GB and refused on 8.
  const small = await setup(t, { tokenCount: 60000, totalMemoryBytes: 8 * GIB });
  await assert.rejects(
    () => small.modelManager.runInference(small.modelId, LONG_PROMPT, { systemPrompt: "Notes." }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );
  assert.equal(small.calls.completions, 0);
});

test("a running server whose context is unknown is not restarted for a short request", async (t) => {
  // A ready server always has at least the starting context. Treating an
  // unknown value as zero restarted every warm server on its next request.
  const { modelManager, modelId, restarts, serverManager } = await setup(t, { tokenCount: 40 });
  serverManager.contextSize = null;

  await modelManager.runInference(modelId, SHORT_PROMPT, { systemPrompt: "Clean up." });

  assert.deepEqual(restarts, []);
});

test("a caller's context floor cannot breach the machine's ceiling", async (t) => {
  // ReasoningConfig.contextSize raises the floor a request starts at, but the
  // ceiling is the memory guarantee: honouring a floor the machine cannot
  // afford is exactly the unbounded KV cache that panicked #1203.
  //
  // 12 GiB puts the ceiling strictly between the baseline and the floor, so
  // the three possible outcomes — clamp to the ceiling, collapse to the
  // baseline, obey the floor — are told apart. The assertions stay relational
  // because the exact ceiling is the policy's arithmetic, not this test's, and
  // because it must hold on Linux CI too (below the 65536 unverified-GPU cap,
  // so memory-bound on either platform).
  const { modelManager, modelId, restarts, serverManager } = await setup(t, {
    tokenCount: 40,
    totalMemoryBytes: 12 * GIB,
  });

  await modelManager.runInference(modelId, SHORT_PROMPT, {
    systemPrompt: "Edit this selection.",
    contextSize: 131072,
  });

  assert.equal(restarts.length, 1, "the raised floor should grow the window once");
  const [started] = restarts;
  assert.ok(started > 16384, `should grow past the baseline, started at ${started}`);
  assert.ok(started < 131072, `must never reach the caller's floor, started at ${started}`);
  assert.equal(serverManager.contextSize, started);
});

test("a prompt that fits gets a smaller answer rather than a refusal", async (t) => {
  // llama-server only rejects a prompt that overflows the window on its own,
  // so charging the full output reservation up front refused notes that work
  // today. Shrink the answer to what is left instead (#2142).
  const { modelManager, modelId, calls, completionBody } = await setup(t, {
    tokenCount: 13000,
    totalMemoryBytes: 8 * GIB, // ceiling collapses to the 16384 floor
  });

  const result = await modelManager.runInference(modelId, LONG_PROMPT, {
    systemPrompt: "Write meeting notes.",
    maxTokens: 4096,
  });

  assert.equal(result, "done");
  assert.equal(calls.completions, 1, "the request must still be sent");
  // Every token the window has left, not a token less: the prompt was
  // measured exactly, and llama.cpp stops generation at the limit rather than
  // rejecting it, so slack here would only shorten the note for nothing.
  assert.equal(completionBody().max_tokens, 16384 - 13000);
});

test("a prompt leaving no room for a usable answer is still refused", async (t) => {
  const { modelManager, modelId, calls } = await setup(t, {
    tokenCount: 16000,
    totalMemoryBytes: 8 * GIB,
  });

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );
  assert.equal(calls.completions, 0, "must not send a request that cannot answer");
});

test("a selection edit is refused rather than given a clipped answer", async (t) => {
  // requireCompleteOutput means a partial replacement corrupts the user's own
  // text, so trading output room for a smaller answer is not an option there.
  const { modelManager, modelId, calls } = await setup(t, {
    tokenCount: 13000,
    totalMemoryBytes: 8 * GIB,
  });

  await assert.rejects(
    () =>
      modelManager.runInference(modelId, LONG_PROMPT, {
        systemPrompt: "Rewrite the selection.",
        maxTokens: 8192,
        requireCompleteOutput: true,
      }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );
  assert.equal(calls.completions, 0);
});

test("a grow that fails comes back at the window that was working", async (t) => {
  // start() stops the running server before it spawns the bigger one, so a
  // grow that dies takes a working window with it. Restoring it keeps local
  // inference alive for the next request instead of until the next launch.
  const { modelManager, modelId, serverManager } = await setup(t, { tokenCount: 20514 });
  const port = serverManager.port;
  const attempts = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    attempts.push(options.contextSize);
    if (options.contextSize > 16384) {
      throw new Error(
        "llama-server process died during startup (signal: SIGKILL)\n" +
          "Process output: ggml_metal: failed to allocate buffer of size 4096.00 MiB"
      );
    }
    serverManager.ready = true;
    serverManager.process = {};
    serverManager.port = port;
  };

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );

  assert.deepEqual(attempts, [32768, 16384], "one failed grow, then back to what worked");
  assert.equal(serverManager.ready, true, "the user must not be left without a server");
});

test("a server that cannot come back reports a typed failure, not llama.cpp stderr", async (t) => {
  const { modelManager, modelId, serverManager } = await setup(t, { tokenCount: 20514 });
  serverManager._doStart = async () => {
    throw new Error(
      "llama-server process died during startup (signal: SIGKILL)\n" +
        "Process output: ggml_metal_graph_compute: command buffer 0 failed with status 5"
    );
  };

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => {
      assert.equal(error.code, "LOCAL_SERVER_UNAVAILABLE");
      assert.ok(
        !error.message.includes("Process output"),
        `server output leaked: ${error.message}`
      );
      // details crosses IPC to the renderer, so the startup dump must not ride
      // along in there either — it belongs in the main-process log.
      assert.ok(
        !JSON.stringify(error.details).includes("Process output"),
        `server output leaked through details: ${JSON.stringify(error.details)}`
      );
      return true;
    }
  );
});

test("an answer too small to be worth generating is refused rather than stubbed", async (t) => {
  // 16100 of a 16384 window leaves 284 tokens, a few sentences for a whole
  // meeting. Below the floor the honest answer is that it does not fit, not a
  // stub saved as the note.
  const { modelManager, modelId, calls } = await setup(t, {
    tokenCount: 16100,
    totalMemoryBytes: 8 * GIB,
  });

  await assert.rejects(
    () =>
      modelManager.runInference(modelId, LONG_PROMPT, {
        systemPrompt: "Write notes.",
        maxTokens: 4096,
      }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );
  assert.equal(calls.completions, 0);
});

test("a start that steps the context down is not retried at the size that stepped down", async (t) => {
  // The GPU ladder can load a smaller window than it was asked for without
  // ever throwing. Treating that as success left the preflight to ask for the
  // same window again, paying a second full model load to be stepped down
  // again — the wasted restart the memo exists to prevent.
  const { modelManager, modelId, serverManager } = await setup(t, { tokenCount: 20514 });
  const port = serverManager.port;
  const attempts = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    attempts.push(options.contextSize);
    serverManager.ready = true;
    serverManager.process = {};
    serverManager.port = port;
    // What _startWithGpuFallback records when the reduced-context rung wins.
    serverManager.activeContextSize = 16384;
  };

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => error.code === "CONTEXT_TOO_LARGE"
  );

  assert.deepEqual(attempts, [32768], "the step-down must be remembered, not re-attempted");
});

test("a server that already died is not restored to a window it no longer has", async (t) => {
  // llamaServer clears contextSize only in stop(); a crash or a failed health
  // check leaves it set while ready goes false. Reading it blind made a failed
  // start pay for a second one that was never going to help.
  const { modelManager, modelId, serverManager } = await setup(t, { tokenCount: 20514 });
  serverManager.ready = false;
  serverManager.process = null;

  const attempts = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    attempts.push(options.contextSize);
    throw new Error("llama-server process died during startup (signal: SIGKILL)");
  };

  await assert.rejects(
    () => modelManager.runInference(modelId, LONG_PROMPT, { systemPrompt: "Write notes." }),
    (error) => error.code === "LOCAL_SERVER_UNAVAILABLE"
  );

  assert.deepEqual(attempts, [32768], "no second attempt at a window that was already gone");
});

test("only Apple Silicon is treated as memory the GPU already shares", async (t) => {
  // discreteGpuUnverified reads darwin as unified memory, but an Intel Mac's
  // Radeon has its own few GB. Sizing against system RAM there hands the card
  // a context it cannot hold — and the darwin start path has no reduced-context
  // rung to fall back on.
  const real = { platform: process.platform, arch: process.arch };
  const pretend = (platform, arch) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  };
  t.after(() => pretend(real.platform, real.arch));

  // Both managers are built before any pretending, so only the ceiling
  // decision sees the faked platform.
  const roomy = { tokenCount: 40, totalMemoryBytes: 64 * GIB };
  const apple = await setup(t, roomy);
  const intel = await setup(t, roomy);
  const model = modelRegistryData.localProviders[0].models[0];
  const ceilingFor = (manager) =>
    manager.contextCeiling({ model }, path.join(manager.modelsDir, model.fileName));

  pretend("darwin", "arm64");
  const unified = await ceilingFor(apple.modelManager);
  pretend("darwin", "x64");
  const discrete = await ceilingFor(intel.modelManager);

  assert.notEqual(unified.reason, "gpu-cap", "unified memory needs no unverified-GPU cap");
  assert.equal(discrete.reason, "gpu-cap", "an Intel Mac's GPU memory is not system memory");
  assert.ok(discrete.ceiling < unified.ceiling);
});
