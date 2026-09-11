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

  return { modelManager, modelId: model.id, calls, restarts, serverManager };
}

test("a short request costs no measurement and no restart", async (t) => {
  // The dictation-cleanup invariant. Every dictation goes through this path;
  // adding a round trip or a restart here would be a far worse regression than
  // the bug being fixed.
  const { modelManager, modelId, calls, restarts } = await setup(t, { tokenCount: 40 });

  const result = await modelManager.runInference(modelId, SHORT_PROMPT, {
    systemPrompt: "Clean up dictation.",
  });

  assert.equal(result, "done");
  assert.equal(restarts.length, 0, "a short request must not restart the server");
  assert.equal(calls.tokenize, 0, "a short request must not pay for tokenization");
  assert.equal(calls.completions, 1);
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
