const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const { buildGguf, LLAMA_3_2_3B_ENTRIES } = require("./harness/ggufFixtures");

// Drives the primary local LLM path end to end — the IPC bridge
// (localReasoningBridge) → modelManagerBridge.runInference →
// llamaServer.inference — against an HTTP stub standing in for llama-server,
// so the request body that actually reaches the wire is what gets asserted.
// Electron is stubbed the same way modelManagerBridgeDownloadStatus.test.js
// does; the fake model file and the pre-"started" server keep runInference on
// its happy path without spawning anything.

const originalLoad = Module._load;
const CHAIN_MODULES = [
  "../../src/services/localReasoningBridge.js",
  "../../src/helpers/modelManagerBridge.js",
  "../../src/helpers/modelDirUtils.js",
  "../../src/helpers/llamaServer.js",
].map((relative) => require.resolve(relative));
let electronHome = os.tmpdir();

function loadChain() {
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
    const bridge = require("../../src/services/localReasoningBridge.js").default;
    const modelManager = require("../../src/helpers/modelManagerBridge.js").default;
    // Pin modelsDir to the temp home. getCacheRoot() prefers OPENWHISPR_CACHE_ROOT,
    // XDG_CACHE_HOME (linux) and USERPROFILE (win32) over the stubbed home, and
    // migrates model folders when they differ, so it must not run here (#3244).
    modelManager.getModelsDir = () => path.join(electronHome, ".cache", "openwhispr", "models");
    return { bridge, modelManager };
  } finally {
    Module._load = originalLoad;
  }
}

// A real GGUF header padded past the minimum-size check, so the context
// ceiling is computed from the model's own architecture rather than falling
// back to the baseline the moment a caller asks for a bigger window.
const MODEL_FILE = Buffer.concat([buildGguf(LLAMA_3_2_3B_ENTRIES), Buffer.alloc(1_000_001, 1)]);
const ROOMY_MACHINE_BYTES = 48 * 1024 * 1024 * 1024;

// Stands up the stub server plus a bridge whose model manager already
// believes llama-server is running that model on the stub's port.
async function setupChain(t, respond) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openwhispr-local-chain-"));
  electronHome = home;
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (req.url === "/slots") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
        return;
      }
      const body = JSON.parse(raw);
      requests.push(body);
      // null leaves the request hanging, like a model still generating; a
      // promise holds the reply until it settles.
      const reply = await respond(body);
      if (reply === null) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const { bridge, modelManager } = loadChain();
  const model = modelRegistryData.localProviders[0].models[0];
  modelManager.ensureInitialized();
  await fs.mkdir(modelManager.modelsDir, { recursive: true });
  await fs.writeFile(path.join(modelManager.modelsDir, model.fileName), MODEL_FILE);
  modelManager._systemMemoryBytes = () => ROOMY_MACHINE_BYTES;

  const serverManager = modelManager.serverManager;
  serverManager.cachedServerBinaryPaths = { default: "/stub/llama-server" };
  serverManager.modelPath = path.join(modelManager.modelsDir, model.fileName);
  serverManager.ready = true;
  serverManager.process = {};
  serverManager.port = server.address().port;
  modelManager.currentServerModelId = model.id;
  t.after(() => serverManager.clearIdleTimer());

  return { bridge, modelManager, modelId: model.id, requests, serverManager, server };
}

const completion = (finishReason, content) => ({
  choices: [{ finish_reason: finishReason, message: { content } }],
});

test("requireCompleteOutput rejects a truncated reply through the whole local chain", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial edi"));

  await assert.rejects(
    () => bridge.processText("edit this", modelId, { requireCompleteOutput: true }),
    (error) => {
      assert.equal(error.code, "OUTPUT_TRUNCATED");
      assert.match(error.message, /truncated/);
      return true;
    }
  );
});

test("a truncated reply still resolves when the caller did not require complete output", async (t) => {
  const { bridge, modelId } = await setupChain(t, () => completion("length", "partial"));

  assert.equal(await bridge.processText("clean this", modelId, {}), "partial");
});

test("an explicit temperature of 0 reaches llama-server instead of the 0.7 default", async (t) => {
  const { bridge, modelId, requests } = await setupChain(t, () => completion("stop", "ok"));

  await bridge.processText("clean this", modelId, { temperature: 0 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].response_format, undefined);
});

test("structured selection output reaches the wire and preserves literal thinking tags", async (t) => {
  const { SELECTION_EDIT_RESPONSE_FORMAT, extractLocalSelectionEditReplacement } =
    await import("../../src/helpers/selectionEditing.js");
  const replacement = '  <think>keep me</think> "quoted" \\path\n';
  const { bridge, modelId, requests } = await setupChain(t, () =>
    completion("stop", JSON.stringify({ replacement }))
  );
  const response = await bridge.processText("edit request", modelId, {
    systemPrompt: "Dedicated editor",
    requireCompleteOutput: true,
    responseFormat: SELECTION_EDIT_RESPONSE_FORMAT,
    disableThinking: true,
  });
  assert.deepEqual(requests[0].response_format, SELECTION_EDIT_RESPONSE_FORMAT);
  assert.deepEqual(requests[0].messages, [
    { role: "system", content: "Dedicated editor" },
    { role: "user", content: "edit request" },
  ]);
  assert.equal(extractLocalSelectionEditReplacement(response), replacement);
});

test("structured selection output requires confirmed completion and real answer content", async (t) => {
  const { SELECTION_EDIT_RESPONSE_FORMAT, extractLocalSelectionEditReplacement } =
    await import("../../src/helpers/selectionEditing.js");
  let reply;
  const { bridge, modelId } = await setupChain(t, () => reply);
  for (const finishReason of ["length", "max_tokens", undefined, null, "tool_calls", "unknown"]) {
    reply = completion(finishReason, '{"replacement":"looks complete"}');
    await assert.rejects(
      bridge.processText("edit", modelId, {
        requireCompleteOutput: true,
        responseFormat: SELECTION_EDIT_RESPONSE_FORMAT,
      }),
      {
        code: ["length", "max_tokens"].includes(finishReason)
          ? "OUTPUT_TRUNCATED"
          : "OUTPUT_COMPLETION_UNVERIFIED",
      }
    );
  }
  for (const content of ["", " \n", undefined, null, [], 123]) {
    reply = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content,
            reasoning_content: '{"replacement":"not an answer"}',
          },
        },
      ],
    };
    const response = await bridge.processText("edit", modelId, {
      responseFormat: SELECTION_EDIT_RESPONSE_FORMAT,
    });
    assert.throws(() => extractLocalSelectionEditReplacement(response), {
      code: "SELECTION_EDIT_EMPTY_RESPONSE",
    });
  }
});

test("a caller's contextSize reaches the server start (regression: it was dropped)", async (t) => {
  // ReasoningConfig.contextSize was declared, written by selection editing,
  // and then rebuilt away in this bridge, so it never reached anything. The
  // field only means something now that the server can grow, so the wiring
  // needs a guard that fails if anyone rebuilds the config object again.
  // It raises the floor only as far as the machine's ceiling allows, which is
  // why this harness has to present a machine and a model that can afford it.
  const { bridge, modelId, serverManager } = await setupChain(t, () => completion("stop", "ok"));

  const started = [];
  serverManager._doStart = async (modelPath, options = {}) => {
    started.push(options.contextSize);
    serverManager.ready = true;
    serverManager.process = {};
  };
  serverManager.stop = async () => {
    serverManager.ready = false;
    serverManager.process = null;
    serverManager.contextSize = null;
  };
  serverManager.contextSize = 16384;

  await bridge.processText("short text", modelId, { contextSize: 32768 });

  assert.deepEqual(started, [32768]);
});

test("refuseClippedByWindow reaches runInference (the bridge rebuilds the config)", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  const forwarded = [];
  const runInference = modelManager.runInference.bind(modelManager);
  modelManager.runInference = (id, text, options) => {
    forwarded.push(options);
    return runInference(id, text, options);
  };

  await bridge.processText("summarise this", modelId, { refuseClippedByWindow: true });

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].refuseClippedByWindow, true);
});

test("a second request while one is in flight is refused with a typed code", async (t) => {
  // A note summarised in parts holds the bridge for minutes; whatever arrives
  // meanwhile (another note's action, dictation cleanup) must fail with a code
  // the renderer can translate rather than the raw guard text.
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  let release;
  modelManager.runInference = () =>
    new Promise((resolve) => {
      release = () => resolve("first reply");
    });

  const first = bridge.processText("first", modelId, {});
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(bridge.processText("second", modelId, {}), (error) => {
    assert.equal(error.code, "LOCAL_MODEL_BUSY");
    return true;
  });

  release();
  assert.equal(await first, "first reply");
});

test("a caller's busy wait reaches runInference", async (t) => {
  // This object is rebuilt field by field, which is how contextSize once got lost.
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  let received;
  modelManager.runInference = async (_modelId, _text, options) => {
    received = options.busyWaitMs;
    return "ok";
  };

  await bridge.processText("text", modelId, { busyWaitMs: 1234 });
  assert.equal(received, 1234);
});

test("cancel reaches a request still waiting for the server, and frees the slot", async (t) => {
  // A note action waiting out a chat answer on another model would otherwise
  // swap its model in and run once the answer finished, long after the cancel.
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "ok"));
  modelManager.runInference = (_modelId, _text, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("cancelled"), { code: "LOCAL_MODEL_CANCELLED" }))
      );
    });

  const waiting = bridge.processText("text", modelId, { requestId: "note-1" });
  bridge.cancel("note-1");
  await assert.rejects(waiting, { code: "LOCAL_MODEL_CANCELLED" });
  assert.equal(bridge.isProcessing, false);
});

test("cancel aborts only the in-flight request carrying that id, and frees the slot", async (t) => {
  // A note cancelled mid-part used to hold the one local slot until the model
  // finished, so an immediate rerun (or dictation cleanup) was refused as busy.
  let hang = true;
  const { bridge, modelId, requests } = await setupChain(t, () =>
    hang ? null : completion("stop", "ok")
  );

  const pending = bridge.processText("long part", modelId, { requestId: "run-1" });
  const settled = pending.then(
    () => "resolved",
    (error) => error
  );
  while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  bridge.cancel("run-2");
  const stillPending = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  assert.equal(stillPending, "pending", "another caller's id must not abort this request");

  bridge.cancel("run-1");
  assert.ok((await settled) instanceof Error, "the tagged request is aborted");

  hang = false;
  assert.equal(await bridge.processText("next", modelId, {}), "ok");
});

test("cancellation during startup or preflight prevents inference and releases the local bridge", async (t) => {
  for (const stage of ["startup", "preflight"]) {
    await t.test(stage, async (t) => {
      const { bridge, modelManager, modelId, requests, serverManager } = await setupChain(t, () =>
        completion("stop", "cleanup")
      );
      const controller = new AbortController();
      if (stage === "startup") {
        serverManager.ready = false;
        serverManager.start = async () => {
          controller.abort();
          bridge.cancel("revoked-job");
          serverManager.ready = true;
        };
      } else {
        const preflight = modelManager._ensurePromptFits;
        modelManager._ensurePromptFits = async () => {
          controller.abort();
          bridge.cancel("revoked-job");
          return 512;
        };
        t.after(() => {
          modelManager._ensurePromptFits = preflight;
        });
      }
      await assert.rejects(
        bridge.processText("private", modelId, {
          requestId: "revoked-job",
          signal: controller.signal,
        }),
        { name: "AbortError" }
      );
      assert.equal(requests.length, 0);
      assert.equal(bridge.isProcessing, false);
    });
  }
});

test("cancellation after context metadata prevents tokenization and inference", async (t) => {
  const { bridge, modelId, requests, serverManager } = await setupChain(t, () =>
    completion("stop", "unused")
  );
  const controller = new AbortController();
  serverManager.usableContextSize = async () => {
    controller.abort();
    return 4096;
  };
  await assert.rejects(
    bridge.processText("word ".repeat(6000), modelId, { maxTokens: 32, signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.equal(requests.length, 0);
  assert.equal(bridge.isProcessing, false);
});

// --- several texts at once (processTextBatch) -------------------------------
//
// The dropped-words guard re-cleans a part in pieces of up to 150 words, four
// at a time: llama-server runs four slots, so one request at a time leaves
// three of them idle.

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Settles with the promise, or rejects rather than leave the test hanging.
const within = (promise, ms = 2000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`still pending after ${ms}ms`)), ms).unref();
    }),
  ]);

const codedError = (message, code) => Object.assign(new Error(message), { code });

// Stands in for runInference: each call waits for the test to answer it, and
// gives up when its signal aborts, as a request waiting for the server does.
function holdInference(modelManager) {
  const calls = [];
  let inFlight = 0;
  let mostInFlight = 0;
  modelManager.runInference = (_modelId, text, options) => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const { promise, resolve, reject } = Promise.withResolvers();
    options.signal.addEventListener(
      "abort",
      () => reject(codedError("cancelled", "LOCAL_MODEL_CANCELLED")),
      { once: true }
    );
    calls.push({ text, options, resolve, reject });
    return promise.finally(() => {
      inFlight -= 1;
    });
  };
  return { calls, mostInFlight: () => mostInFlight };
}

test("a batch keeps its order and never has more than four texts in flight", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const held = holdInference(modelManager);
  const texts = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

  const batch = bridge.processTextBatch(texts, modelId, {});
  await waitFor(() => held.calls.length === 4, "four texts in flight");
  await settle();
  assert.equal(held.calls.length, 4, "a fifth waits for one of the four to finish");

  // Answering the newest first brings every answer back out of order.
  for (let answered = 0; answered < texts.length; answered += 1) {
    await waitFor(
      () => held.calls.length === Math.min(texts.length, answered + 4),
      "the next text once one finished"
    );
    const call = held.calls.findLast((candidate) => !candidate.answered);
    call.answered = true;
    call.resolve(`clean ${call.text}`);
  }

  assert.deepEqual(
    await within(batch),
    texts.map((text) => ({ success: true, text: `clean ${text}` }))
  );
  assert.equal(held.mostInFlight(), 4);
});

// The four slots share one KV cache the size of the window. Four of the
// reviewer's ~3.7k-token prompts with a 1,900-token answer allowance each got a
// 500 "Context size has been exceeded" from the bundled server at 16,384.
test("a batch runs only as many texts at once as fit in the window side by side", async (t) => {
  const { bridge, modelManager, modelId, serverManager } = await setupChain(t, () =>
    completion("stop", "unused")
  );
  const mostAtOnce = async (config) => {
    const held = holdInference(modelManager);
    const batch = bridge.processTextBatch(["1", "2", "3", "4", "5", "6"], modelId, config);
    for (let answered = 0; answered < 6; answered += 1) {
      await waitFor(() => held.calls.length > answered, "the next text");
      held.calls[answered].resolve("clean");
    }
    await within(batch);
    return held.mostInFlight();
  };
  // About 5,900 tokens of system prompt, and 1,000 more per text for its answer.
  const dictionary = { systemPrompt: "dictionary ".repeat(1600) };

  assert.equal(await mostAtOnce({}), 4, "everyday texts use every slot");
  assert.equal(await mostAtOnce(dictionary), 2, "two fit the 16,384 floor");
  assert.equal(
    await mostAtOnce({ systemPrompt: "dictionary ".repeat(2000) }),
    1,
    "a text that needs half the window runs alone"
  );

  serverManager.contextSize = 32768;
  assert.equal(await mostAtOnce(dictionary), 4, "this model's running window holds four");
  modelManager.currentServerModelId = "another-model";
  assert.equal(await mostAtOnce(dictionary), 2, "another model's window says nothing");
});

test("each text in a batch gets the request and answer processText gives it", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const sent = [];
  modelManager.runInference = async (id, text, { signal, ...options }) => {
    assert.ok(signal instanceof AbortSignal);
    sent.push({ id, text, options });
    return ` <think>planning</think> clean ${text.length} `;
  };
  const texts = ["short", "a much longer piece of dictation ".repeat(40)];
  const requestsFor = async (config) => {
    sent.length = 0;
    const results = await bridge.processTextBatch(texts, modelId, config);
    const batchRequests = sent.splice(0);
    const singles = [];
    for (const text of texts) singles.push(await bridge.processText(text, modelId, config));
    assert.deepEqual(batchRequests, sent);
    assert.deepEqual(
      results,
      singles.map((text) => ({ success: true, text }))
    );
    return batchRequests;
  };

  const shaped = await requestsFor({
    systemPrompt: "Clean up.",
    temperature: 0,
    disableThinking: true,
    requireCompleteOutput: true,
    refuseClippedByWindow: true,
    contextSize: 32768,
    busyWaitMs: 1234,
  });
  // Each text's own length sizes its answer, unless the caller fixed the size.
  assert.deepEqual(
    shaped.map((request) => request.options.maxTokens),
    [512, 2048]
  );
  assert.equal(shaped[1].options.contextSize, 32768);
  const capped = await requestsFor({ maxTokens: 300 });
  assert.deepEqual(
    capped.map((request) => request.options.maxTokens),
    [300, 300]
  );
});

test("a batch and any other request refuse each other with the typed busy code", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const held = holdInference(modelManager);
  const busy = { code: "LOCAL_MODEL_BUSY" };

  const batch = bridge.processTextBatch(["one", "two"], modelId, {});
  await waitFor(() => held.calls.length === 2, "the batch in flight");
  await assert.rejects(bridge.processText("dictation", modelId, {}), busy);
  await assert.rejects(bridge.processTextBatch(["other"], modelId, {}), busy);
  held.calls[0].resolve("one");
  await settle();
  await assert.rejects(bridge.processText("dictation", modelId, {}), busy, "until the last text");
  held.calls[1].resolve("two");
  await within(batch);

  const single = bridge.processText("note", modelId, {});
  await waitFor(() => held.calls.length === 3, "the single request in flight");
  await assert.rejects(bridge.processTextBatch(["piece"], modelId, {}), busy);
  held.calls[2].resolve("note answer");
  assert.equal(await within(single), "note answer");
  assert.equal(held.calls.length, 3, "a refused request never reached the model");
});

test("a text whose own answer fails gets that failure in its place; the rest still run", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const ownFailures = ["CONTEXT_TOO_LARGE", "OUTPUT_TRUNCATED", "OUTPUT_COMPLETION_UNVERIFIED"];
  modelManager.runInference = async (_modelId, text) => {
    if (ownFailures.includes(text)) throw codedError(`${text} happened`, text);
    return `clean ${text}`;
  };

  assert.deepEqual(await bridge.processTextBatch(["first", ...ownFailures, "last"], modelId, {}), [
    { success: true, text: "clean first" },
    ...ownFailures.map((code) => ({ success: false, error: `${code} happened`, code })),
    { success: true, text: "clean last" },
  ]);
  assert.equal(bridge.isProcessing, false);
});

for (const [label, code] of [
  ["a busy server", "LOCAL_MODEL_BUSY"],
  ["a server that cannot start", "LOCAL_SERVER_UNAVAILABLE"],
  ["a server that failed the request", "INFERENCE_FAILED"],
  ["a policy refusal", "POLICY_MODEL_BLOCKED"],
  ["a failure with no code", undefined],
]) {
  test(`${label} ends the whole batch and stops what is left of it`, async (t) => {
    const { bridge, modelManager, modelId } = await setupChain(t, () =>
      completion("stop", "unused")
    );
    const held = holdInference(modelManager);
    let cancels = 0;
    modelManager.cancelInference = () => {
      cancels += 1;
    };

    const batch = bridge.processTextBatch(["1", "2", "3", "4", "5", "6"], modelId, {});
    await waitFor(() => held.calls.length === 4, "four texts in flight");
    held.calls[0].resolve("clean 1");
    await waitFor(() => held.calls.length === 5, "a fifth text");
    held.calls[2].reject(codedError("no", code));

    await assert.rejects(within(batch), (error) => error.message === "no" && error.code === code);
    assert.equal(cancels, 1, "the requests still in flight are closed");
    assert.equal(held.calls.length, 5, "the sixth text never starts");
    assert.equal(bridge.isProcessing, false);
  });
}

test("cancelling a batch by its id stops the texts in flight and starts no more", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const held = holdInference(modelManager);
  let cancels = 0;
  modelManager.cancelInference = () => {
    cancels += 1;
  };

  const batch = bridge.processTextBatch(["1", "2", "3", "4", "5", "6"], modelId, {
    requestId: "guard-1",
  });
  await waitFor(() => held.calls.length === 4, "four texts in flight");
  bridge.cancel("guard-2");
  await settle();
  assert.equal(cancels, 0, "another caller's id cancels nothing");

  bridge.cancel("guard-1");
  await assert.rejects(within(batch), { code: "LOCAL_MODEL_CANCELLED" });
  assert.equal(cancels, 1);
  assert.equal(held.calls.length, 4, "the texts not yet started never start");
  assert.equal(bridge.isProcessing, false);
});

test("the caller's signal aborting rejects the batch the same way", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const held = holdInference(modelManager);
  const caller = new AbortController();

  const batch = bridge.processTextBatch(["1", "2", "3", "4", "5"], modelId, {
    signal: caller.signal,
  });
  await waitFor(() => held.calls.length === 4, "four texts in flight");
  caller.abort();
  await assert.rejects(within(batch), { code: "LOCAL_MODEL_CANCELLED" });
  assert.equal(held.calls.length, 4);

  await assert.rejects(within(bridge.processTextBatch(["6"], modelId, { signal: caller.signal })), {
    code: "LOCAL_MODEL_CANCELLED",
  });
  assert.equal(held.calls.length, 4, "an aborted caller's batch never starts");
  assert.equal(bridge.isProcessing, false);
});

// runInference is a stand-in here, so its own debug lines are not checked.
test("the batch's own log lines carry counts and timings, never what was said", async (t) => {
  const { bridge, modelManager, modelId } = await setupChain(t, () => completion("stop", "unused"));
  const debugLogger = require("../../src/helpers/debugLogger");
  const logged = [];
  t.mock.method(debugLogger, "logReasoning", (stage, details) => {
    logged.push(JSON.stringify([stage, details]));
  });
  modelManager.runInference = async (_modelId, text) => {
    if (text === "private two") throw codedError("Model output was truncated", "OUTPUT_TRUNCATED");
    return `cleaned ${text}`;
  };
  const config = { systemPrompt: "Spell Zyxwv this way." };

  await bridge.processTextBatch(["private one", "private two"], modelId, config);
  modelManager.runInference = async () => {
    throw codedError("no server", "LOCAL_SERVER_UNAVAILABLE");
  };
  await assert.rejects(bridge.processTextBatch(["private three"], modelId, config));

  assert.ok(logged.length >= 4);
  for (const line of logged) assert.doesNotMatch(line, /private|Zyxwv/);
});

// Through the real runInference and llamaServer, against the stub server.

test("a batch puts four texts on the running server at once and never restarts it", async (t) => {
  const answer = Promise.withResolvers();
  const { bridge, modelId, requests, serverManager } = await setupChain(t, async (body) => {
    await answer.promise;
    return completion("stop", `clean ${body.messages[1].content}`);
  });
  const restarts = [];
  serverManager._doStart = async () => restarts.push("start");
  serverManager.stop = async () => restarts.push("stop");
  const texts = ["one", "two", "three", "four", "five", "six"];

  const batch = bridge.processTextBatch(texts, modelId, {});
  await waitFor(() => requests.length === 4, "four requests at the server");
  await settle();
  assert.equal(requests.length, 4, "a fifth waits for a free slot");
  assert.equal(serverManager.activeRequests.size, 4);

  answer.resolve();
  assert.deepEqual(
    await within(batch),
    texts.map((text) => ({ success: true, text: `clean ${text}` }))
  );
  assert.deepEqual(restarts, []);
});

test("texts arriving together at a stopped server share one start", async (t) => {
  const { bridge, modelId, serverManager } = await setupChain(t, (body) =>
    completion("stop", `clean ${body.messages[1].content}`)
  );
  const { port } = serverManager;
  serverManager.ready = false;
  serverManager.process = null;
  let starts = 0;
  serverManager._doStart = async (modelPath) => {
    starts += 1;
    await settle();
    Object.assign(serverManager, { modelPath, port, ready: true, process: {} });
  };
  const texts = ["one", "two", "three", "four"];

  const results = await within(bridge.processTextBatch(texts, modelId, {}));

  assert.equal(starts, 1);
  assert.deepEqual(
    results,
    texts.map((text) => ({ success: true, text: `clean ${text}` }))
  );
});

test("cancelling a batch closes every request it has at the server and sends no more", async (t) => {
  const { bridge, modelId, requests, serverManager } = await setupChain(t, () => null);

  const batch = bridge.processTextBatch(["1", "2", "3", "4", "5", "6"], modelId, {
    requestId: "guard-1",
  });
  const outcome = batch.then(
    () => "resolved",
    (error) => error
  );
  await waitFor(
    () => requests.length === 4 && serverManager.activeRequests.size === 4,
    "four requests at the server"
  );

  bridge.cancel("guard-1");
  assert.equal((await within(outcome)).code, "LOCAL_MODEL_CANCELLED");
  assert.equal(serverManager.activeRequests.size, 0);
  await settle();
  assert.equal(requests.length, 4, "the texts not yet sent never reach the server");
  assert.equal(bridge.isProcessing, false);
});

// A stopped server may be stopped on purpose (a GPU switch, a policy), so the
// texts left must not load the model again.
test("a server that dies under a batch ends it, and the rest never reload the model", async (t) => {
  const { bridge, modelId, requests, serverManager, server } = await setupChain(t, () => null);
  let starts = 0;
  serverManager._doStart = async () => {
    starts += 1;
    serverManager.ready = true;
    serverManager.process = {};
  };

  const batch = bridge.processTextBatch(["1", "2", "3", "4", "5", "6"], modelId, {});
  await waitFor(
    () => requests.length === 4 && serverManager.activeRequests.size === 4,
    "four requests at the server"
  );
  // What llama-server exiting looks like from main: its handle goes, and the
  // connections it held drop.
  serverManager.ready = false;
  serverManager.process = null;
  server.closeAllConnections();

  await assert.rejects(within(batch), { code: "INFERENCE_FAILED" });
  assert.equal(starts, 0);
  assert.equal(requests.length, 4);
  assert.equal(bridge.isProcessing, false);
});
