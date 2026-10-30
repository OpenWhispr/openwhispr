const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// The interaction card mounted for real in happy-dom over the real store. The
// settings store brings the app's i18n with it, so labels are in English.
async function installHappyDom(t) {
  const { Window } = await import("happy-dom");
  const happyWindow = new Window();
  const fromWindow = ["document", "Node", "Element", "HTMLElement", "Event", "KeyboardEvent"];
  const names = ["window", ...fromWindow, "localStorage", "IS_REACT_ACT_ENVIRONMENT"];
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of fromWindow) define(name, happyWindow[name]);
  define("localStorage", happyWindow.localStorage);
  define("IS_REACT_ACT_ENVIRONMENT", true);
  t.after(async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await happyWindow.happyDOM.close();
  });
  return happyWindow;
}

async function mountCard(t, payload) {
  let root = null;
  // Node runs after hooks in registration order: unmount while the DOM exists.
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  happyWindow.electronAPI = {};
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-interaction-card-test-" });
  const store = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const { InteractionCard } = await vite.ssrLoadModule("/components/chat/InteractionCard.tsx");
  // The real setter saves through IPC; the test only needs what reaches it.
  const savedKeys = [];
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ setOpenaiApiKey: (value) => savedKeys.push(value) });
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  store.useAgentInteractionStore.setState({ entries: {} });
  const results = [];
  store.restoreInteraction({ messageId: "m1", toolCallId: "c1", payload }, (result) =>
    results.push(result)
  );

  function Harness() {
    const entry = store.useAgentInteractionStore((state) => state.entries["m1::c1"]);
    return entry && entry.state !== "settled"
      ? React.createElement(InteractionCard, { entry })
      : null;
  }
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  await React.act(async () => root.render(React.createElement(Harness)));

  const type = (input, value) =>
    React.act(async () => {
      Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value").set.call(
        input,
        value
      );
      input.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
    });
  const button = (label) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent === label);
  return { happyWindow, host, store, results, savedKeys, i18n, type, button };
}

test("an API key is typed in a masked field and reaches the saver only", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  const input = card.host.querySelector("input");
  assert.equal(input.type, "password");

  await card.type(input, "sk-qa-secret-123");
  assert.doesNotMatch(JSON.stringify(card.store.useAgentInteractionStore.getState()), /sk-qa/);
  assert.equal(card.button("Save").disabled, false);

  await React.act(async () => card.button("Save").click());
  // The saver loads the settings store on first use.
  for (let i = 0; i < 400 && card.results.length === 0; i += 1) {
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  }
  assert.equal(input.value, "", "the field is cleared once the key is handed over");
  assert.deepEqual(card.savedKeys, ["sk-qa-secret-123"]);
  assert.deepEqual(card.results, [{ status: "saved" }]);
  assert.doesNotMatch(JSON.stringify(card.store.useAgentInteractionStore.getState()), /sk-qa/);
});

test("questions can be submitted only once every one is answered", async (t) => {
  const card = await mountCard(t, {
    kind: "questions",
    questions: [{ id: "city", kind: "text", prompt: "Which city?" }],
  });
  const submit = () => card.button("Submit");
  assert.equal(submit().disabled, true);

  await card.type(card.host.querySelector("input"), "Lisbon");
  assert.equal(submit().disabled, false);
  await React.act(async () => submit().click());
  assert.deepEqual(card.results, [{ status: "answered", answers: { city: "Lisbon" } }]);
});

test("Esc in an answer field stays in the card, never cancelling the turn", async (t) => {
  const card = await mountCard(t, {
    kind: "questions",
    questions: [{ id: "city", kind: "text", prompt: "Which city?" }],
  });
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  const input = card.host.querySelector("input");
  await React.act(async () =>
    input.dispatchEvent(
      new card.happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )
  );
  assert.equal(reachedWindow, 0);
  assert.equal(card.store.useAgentInteractionStore.getState().entries["m1::c1"].state, "pending");
});

test("Esc on an option or a button stays in the card as well", async (t) => {
  const card = await mountCard(t, {
    kind: "questions",
    questions: [
      { id: "tone", kind: "single", prompt: "Which tone?", options: [{ id: "a", label: "Warm" }] },
    ],
  });
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  for (const target of [card.host.querySelector("input"), card.button("Submit")]) {
    await React.act(async () =>
      target.dispatchEvent(
        new card.happyWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
  }
  assert.equal(reachedWindow, 0);
});

test("a card for any calendar has a translated title", async (t) => {
  const card = await mountCard(t, { kind: "connection", target: "calendar" });
  await React.act(async () => card.i18n.changeLanguage("de"));
  assert.match(card.host.textContent, /Kalender verbinden/);
  assert.doesNotMatch(card.host.textContent, /a calendar/);
});
