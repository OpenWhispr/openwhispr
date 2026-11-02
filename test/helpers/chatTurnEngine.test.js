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
  let state = "idle";
  let ownerCurrent = true;
  const writes = [];
  const engine = createChatTurnEngine(
    () => ({
      userName: null,
      isOwnerCurrent: () => ownerCurrent,
      onStreamComplete: (_id, content) => writes.push(content),
    }),
    {
      setMessages: (update) => {
        messages = update(messages);
      },
      setAgentState: (value) => {
        state = value;
      },
      setToolStatus() {},
      setActiveToolName() {},
    }
  );
  return {
    engine,
    service,
    writes,
    messages: () => messages,
    state: () => state,
    invalidate: () => {
      ownerCurrent = false;
    },
  };
}

for (const explicit of [true, false]) {
  test(`${explicit ? "explicit" : "implicit"} cancellation preserves its partial persistence contract`, async (t) => {
    const fixture = await setup(t);
    t.mock.method(
      fixture.service,
      "processTextStreamingAI",
      async function* (_messages, _model, _provider, _config, _tools, signal) {
        yield { type: "content", text: "Partial answer" };
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      }
    );
    const send = fixture.engine.send("hello", []);
    for (let count = 0; count < 20 && fixture.state() !== "streaming"; count++) await flush();
    await flush();
    fixture.engine.cancel({ explicit });
    await send;
    assert.deepEqual(fixture.writes, explicit ? [] : ["Partial answer"]);
    assert.equal(fixture.state(), "idle");
  });
}

test("a replaced account prevents a late response from persisting or reaching the sink", async (t) => {
  const fixture = await setup(t);
  let release;
  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    await new Promise((resolve) => {
      release = resolve;
    });
    yield { type: "content", text: "Old account answer" };
  });
  const send = fixture.engine.send("hello", []);
  while (!release) await flush();
  fixture.invalidate();
  release();
  await send;
  assert.deepEqual(fixture.writes, []);
  assert.equal(
    fixture.messages().some((message) => message.content.includes("Old account")),
    false
  );
});

test("a superseded send cannot set its replacement idle", async (t) => {
  const fixture = await setup(t);
  const releases = [];
  t.mock.method(fixture.service, "processTextStreamingAI", async function* () {
    await new Promise((resolve) => releases.push(resolve));
    yield { type: "content", text: "Answer" };
  });
  const first = fixture.engine.send("one", []);
  while (releases.length < 1) await flush();
  fixture.engine.cancel({ explicit: true });
  const second = fixture.engine.send("two", []);
  while (releases.length < 2) await flush();
  releases[0]();
  await first;
  assert.equal(fixture.state(), "streaming");
  releases[1]();
  await second;
  assert.deepEqual(fixture.writes, ["Answer"]);
});
