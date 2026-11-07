const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { createChatTurnEngine } = await vite.ssrLoadModule("/components/chat/chatTurnEngine.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  (await vite.ssrLoadModule("/stores/policyStore.ts")).usePolicyStore.setState({
    status: "unmanaged",
    policy: null,
  });
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    isSignedIn: false,
  });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  let messages = [];
  const engine = createChatTurnEngine(() => ({ userName: null }), {
    setMessages: (update) => {
      messages = update(messages);
    },
    setAgentState() {},
    setToolStatus() {},
    setActiveToolName() {},
  });
  return { engine, service, messages: () => messages };
}

// Records what a voice call hears, in order.
function speechLog() {
  const events = [];
  const speech = {
    onText: (delta, isUnbacked) => events.push(["text", delta, typeof isUnbacked]),
    onTextWithdrawn: (keptLength) => events.push(["withdrawn", keptLength]),
    onToolCalls: (names) => events.push(["tools", names]),
    onEnd: (outcome) => events.push(["end", outcome]),
  };
  return { events, voice: { replyLanguage: "es", speech } };
}

test("a spoken request's reply is heard as it streams, and its end once", async (t) => {
  const fixture = await setup(t);
  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    yield { type: "content", text: "Claro. " };
    yield { type: "tool_calls", calls: [{ id: "c1", name: "web_search", arguments: "{}" }] };
    yield { type: "tool_result", callId: "c1", toolName: "web_search", displayText: "Found" };
    yield { type: "content", text: "Hace sol." };
    yield { type: "done", finishReason: "stop" };
  });
  const { events, voice } = speechLog();
  await fixture.engine.send("¿Qué tiempo hace?", [], { voice });

  assert.deepEqual(events, [
    ["text", "Claro. ", "function"],
    ["tools", ["web_search"]],
    ["text", "Hace sol.", "function"],
    ["end", "complete"],
  ]);
});

test("a spoken request is answered for speech in its language, without snippet edits", async (t) => {
  const fixture = await setup(t);
  const requests = [];
  t.mock.method(
    fixture.service,
    "processTextStreamingAI",
    async function* (_messages, _model, _provider, config, tools) {
      requests.push({ systemPrompt: config.systemPrompt, tools: Object.keys(tools ?? {}) });
      yield { type: "content", text: "Ok." };
      yield { type: "done", finishReason: "stop" };
    }
  );
  await fixture.engine.send("typed", []);
  const { voice } = speechLog();
  await fixture.engine.send("spoken", [], { voice });
  await fixture.engine.send("spoken, any language", [], {
    voice: { ...voice, replyLanguage: null },
  });

  const [typed, spoken, auto] = requests;
  assert.doesNotMatch(typed.systemPrompt, /read aloud/);
  assert.match(spoken.systemPrompt, /read aloud.*Reply in Spanish\.$/s);
  assert.match(auto.systemPrompt, /Reply in the language the user spoke\.$/);
  assert.ok(typed.tools.includes("update_snippets"));
  assert.equal(spoken.tools.includes("update_snippets"), false);
  assert.ok(spoken.tools.includes("update_dictionary"), "other vocabulary edits stay");
});

test("an answer the claim check asks again is withdrawn from speech before the new one", async (t) => {
  const fixture = await setup(t);
  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    yield { type: "content", text: "I've sent it." };
    yield { type: "unbacked_claim", retry: true };
    yield { type: "content", text: "I haven't sent it yet." };
    yield { type: "done", finishReason: "stop" };
  });
  const { events, voice } = speechLog();
  await fixture.engine.send("send it", [], { voice });

  assert.deepEqual(events, [
    ["text", "I've sent it.", "function"],
    ["withdrawn", 0],
    ["text", "I haven't sent it yet.", "function"],
    ["end", "complete"],
  ]);
  assert.equal(fixture.messages().at(-1).content, "I haven't sent it yet.");
});

test("a stopped spoken request ends as stopped, and a failed one says why", async (t) => {
  const fixture = await setup(t);
  let release;
  t.mock.method(fixture.service, "processTextStreamingAI", async function* (...args) {
    const signal = args[5];
    yield { type: "content", text: "Partial" };
    await new Promise((resolve) => {
      release = resolve;
      signal.addEventListener("abort", resolve, { once: true });
    });
  });
  const stopped = speechLog();
  const send = fixture.engine.send("hello", [], { voice: stopped.voice });
  while (!release) await flush();
  fixture.engine.cancel({ explicit: true });
  await send;
  assert.deepEqual(stopped.events.at(-1), ["end", "stopped"]);
  assert.equal(stopped.events.filter(([kind]) => kind === "end").length, 1);

  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    yield { type: "content", text: "Half an answer" };
    throw new Error("socket hang up");
  });
  const failed = speechLog();
  await fixture.engine.send("hello", [], { voice: failed.voice });
  const [, withdrawn, said, end] = failed.events;
  assert.deepEqual(withdrawn, ["withdrawn", 0]);
  assert.equal(said[0], "text");
  assert.ok(said[1].length > 0, "the failure is spoken");
  assert.deepEqual(end, ["end", "error"]);
});

test("a withdrawn answer keeps the reply spoken before its step", async (t) => {
  const fixture = await setup(t);
  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    yield { type: "content", text: "Claro. " };
    yield { type: "tool_calls", calls: [{ id: "c1", name: "web_search", arguments: "{}" }] };
    yield { type: "tool_result", callId: "c1", toolName: "web_search", displayText: "Found" };
    yield { type: "content", text: "Ya lo envié." };
    yield { type: "unbacked_claim", retry: true };
    yield { type: "content", text: "Todavía no lo envié." };
    yield { type: "done", finishReason: "stop" };
  });
  const { events, voice } = speechLog();
  await fixture.engine.send("envíalo", [], { voice });

  assert.deepEqual(events, [
    ["text", "Claro. ", "function"],
    ["tools", ["web_search"]],
    ["text", "Ya lo envié.", "function"],
    ["withdrawn", "Claro. ".length],
    ["text", "Todavía no lo envié.", "function"],
    ["end", "complete"],
  ]);
});

test("a spoken request leaves out one stopped before any reply, unless it talked over it", async (t) => {
  const fixture = await setup(t);
  const sent = [];
  t.mock.method(fixture.service, "processTextStreamingAI", async function* (messages) {
    sent.push(JSON.stringify(messages));
    yield { type: "content", text: "Four." };
    yield { type: "done", finishReason: "stop" };
  });
  const history = [
    { id: "u1", role: "user", content: "Write a long poem about the ocean.", isStreaming: false },
    {
      id: "a1",
      role: "assistant",
      content: "",
      isStreaming: false,
      turn: { startedAt: 1, finishedAt: 2, status: "stopped" },
    },
    { id: "u2", role: "user", content: "What is 2 plus 2?", isStreaming: false },
  ];
  const { voice } = speechLog();
  await fixture.engine.send("What is 2 plus 2?", history, { voice });
  await fixture.engine.send("What is 2 plus 2?", history, {
    voice: { ...voice, interrupts: true },
  });
  await fixture.engine.send("What is 2 plus 2?", history);

  const [spoken, talkedOver, typed] = sent;
  assert.doesNotMatch(spoken, /ocean/, "an ended or stopped request isn't asked again");
  assert.match(spoken, /2 plus 2/);
  assert.match(talkedOver, /ocean/, "words said over a turn may finish its request");
  assert.match(typed, /ocean/, "typed chat keeps it, noted");
});
