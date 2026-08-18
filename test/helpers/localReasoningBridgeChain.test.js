const test = require("node:test");
const assert = require("node:assert/strict");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const debugLogger = require("../../src/helpers/debugLogger");
const { setupLocalChain, completion } = require("./harness/localChain");

// Pins the contract of the main-process half of the primary local LLM path:
// what localReasoningBridge forwards, what modelManagerBridge.runInference
// passes on, and what llamaServer.inference puts on the wire. The renderer's
// shaping (applyChatCompletionsParams in local.ts) is covered by
// localRequestBodyMatrix.test.js; here `params` is supplied directly so the
// forwarding rules are visible on their own.

const MODEL_ID = modelRegistryData.localProviders[0].models[0].id;

const messagesFor = (text, systemPrompt = "") => [
  { role: "system", content: systemPrompt },
  { role: "user", content: text },
];

async function setup(t, respond) {
  const chain = await setupLocalChain(t, { respond });
  await chain.useModel(MODEL_ID);
  return chain;
}

// --- Phase 0 pins: requireCompleteOutput and explicit zero survive the chain ---

test("requireCompleteOutput rejects a truncated reply through the whole local chain", async (t) => {
  const { bridge } = await setup(t, () => completion("length", "partial edi"));

  await assert.rejects(
    () => bridge.processText("edit this", MODEL_ID, { requireCompleteOutput: true }),
    /truncated/
  );
});

test("a truncated reply still resolves when the caller did not require complete output", async (t) => {
  const { bridge } = await setup(t, () => completion("length", "partial"));

  assert.equal(await bridge.processText("clean this", MODEL_ID, {}), "partial");
});

test("a shaped temperature of 0 reaches llama-server instead of the 0.7 default", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, { params: { temperature: 0 } });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].temperature, 0);
});

// --- Phase 1: shaped params are forwarded verbatim; main never decides sampling ---

test("shaped params reach the wire verbatim and nothing else is invented", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, {
    params: { temperature: 0, max_tokens: 777, chat_template_kwargs: { enable_thinking: false } },
    disableThinking: true,
  });

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this"),
    temperature: 0,
    max_tokens: 777,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  });
});

test("shaped params without chat_template_kwargs stay without them — the renderer already decided", async (t) => {
  const { bridge, requests } = await setup(t);

  // Once params exist the bridge forwards them verbatim: it must not re-add
  // its legacy enable_thinking default from `disableThinking` on top.
  await bridge.processText("clean this", MODEL_ID, {
    params: { temperature: 0, max_tokens: 512 },
    disableThinking: true,
  });

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this"),
    temperature: 0,
    max_tokens: 512,
    stream: false,
  });
});

test("shaped params missing max_tokens get the bridge's length-based fallback", async (t) => {
  const { bridge, requests } = await setup(t);
  const text = "x".repeat(1000);

  await bridge.processText(text, MODEL_ID, { params: { temperature: 0 } });

  assert.deepEqual(requests[0], {
    messages: messagesFor(text),
    temperature: 0,
    max_tokens: 2000,
    stream: false,
  });
});

test("forwards shaped keys it does not know about, so new params need no plumbing edits", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, {
    params: { temperature: 0.7, max_tokens: 100, passthrough_param: "verbatim" },
  });

  assert.equal(requests[0].passthrough_param, "verbatim");
});

test("systemPrompt lands in the messages, never in the body params", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, {
    params: { temperature: 0.3, max_tokens: 100 },
    systemPrompt: "You are an agent.",
  });

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this", "You are an agent."),
    temperature: 0.3,
    max_tokens: 100,
    stream: false,
  });
});

test("requireCompleteOutput rides beside the shaped params all the way to llamaServer.inference", async (t) => {
  const { bridge, inferenceCalls } = await setup(t);

  await bridge.processText("edit this", MODEL_ID, {
    params: { temperature: 0.2, max_tokens: 8192 },
    requireCompleteOutput: true,
  });

  assert.equal(inferenceCalls.length, 1);
  assert.equal(inferenceCalls[0].requireCompleteOutput, true);
});

// --- Unshaped callers (no params) keep the pre-shaping body ---

test("an unshaped caller keeps today's body: 0.7, length-based tokens, enable_thinking off", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, {});

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this"),
    temperature: 0.7,
    max_tokens: 512,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  });
});

test("an unshaped caller that opts out of suppression sends no chat_template_kwargs", async (t) => {
  const { bridge, requests } = await setup(t);

  await bridge.processText("clean this", MODEL_ID, { disableThinking: false });

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this"),
    temperature: 0.7,
    max_tokens: 512,
    stream: false,
  });
});

test("llamaServer.inference called with no params at all still defaults enable_thinking off", async (t) => {
  const { serverManager, requests } = await setup(t);

  await serverManager.inference(messagesFor("clean this"), {});

  assert.deepEqual(requests[0], {
    messages: messagesFor("clean this"),
    temperature: 0.7,
    max_tokens: 512,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  });
});

// --- Observability: the outgoing tunables are visible at debug level ---

test("llamaServer logs the outgoing tunables (not the messages) before sending", async (t) => {
  const { bridge } = await setup(t);
  const logged = [];
  const originalDebug = debugLogger.debug;
  debugLogger.debug = (message, meta) => {
    logged.push({ message, meta });
  };
  t.after(() => {
    debugLogger.debug = originalDebug;
  });

  await bridge.processText("clean this", MODEL_ID, {
    params: { temperature: 0, max_tokens: 777, chat_template_kwargs: { enable_thinking: false } },
    requireCompleteOutput: true,
  });

  const entry = logged.find((e) => e.message === "llama-server inference request");
  assert.ok(entry, "expected an inference-request debug entry");
  assert.deepEqual(entry.meta, {
    temperature: 0,
    max_tokens: 777,
    chat_template_kwargs: { enable_thinking: false },
    requireCompleteOutput: true,
  });
  assert.ok(!("messages" in entry.meta), "prompt content must not be logged");
});
