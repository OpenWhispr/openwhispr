const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The interaction card mounted for real in happy-dom over the real store. The
// settings store brings the app's i18n with it, so labels are in English.
async function mountCard(t, payload, electronAPI = {}) {
  let root = null;
  // Node runs after hooks in registration order: unmount while the DOM exists.
  t.after(() => root && React.act(async () => root.unmount()));
  // Ends the card's wait (and its timer) while the DOM still exists.
  const turn = new AbortController();
  t.after(() => turn.abort());
  const happyWindow = await installHappyDom(t);
  happyWindow.electronAPI = electronAPI;
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-interaction-card-test-" });
  const store = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const { ToolCallCard } = await vite.ssrLoadModule("/components/chat/ChatMessage.tsx");
  // The real setter saves through IPC; the test only needs what reaches it.
  const savedKeys = [];
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ setOpenaiApiKey: (value) => savedKeys.push(value) });
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  store.useAgentInteractionStore.setState({ entries: {} });
  const results = [];
  // A card a running turn waits on.
  void store
    .requestInteraction(
      { messageId: "m1", toolCallId: "c1", signal: turn.signal, onInteraction() {} },
      payload
    )
    .then((result) => results.push(result));

  // The card as the chat shows it: through the tool call it belongs to.
  const card = React.createElement(ToolCallCard, { messageId: "m1", toolCall: { id: "c1" } });
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  await React.act(async () => root.render(card));

  // A layout change: the card goes away and comes back.
  const remount = async () => {
    await React.act(async () => root.render(null));
    await React.act(async () => root.render(card));
  };
  const type = (input, value) =>
    React.act(async () => {
      Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value").set.call(
        input,
        value
      );
      input.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
    });
  const press = (target, key) =>
    React.act(async () =>
      target.dispatchEvent(new happyWindow.KeyboardEvent("keydown", { key, bubbles: true }))
    );
  const click = (element) => React.act(async () => element.click());
  // By its text, or by its label when it is an icon.
  const button = (label) =>
    [...host.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label
    );
  const entry = () => store.useAgentInteractionStore.getState().entries["m1::c1"];
  const wait = (ms) => React.act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  return {
    happyWindow,
    vite,
    host,
    store,
    results,
    savedKeys,
    i18n,
    remount,
    type,
    press,
    click,
    button,
    entry,
    wait,
  };
}

const PLAN = {
  kind: "questions",
  questions: [
    {
      id: "goal",
      kind: "single",
      prompt: "What are you optimizing for?",
      options: [
        { id: "balanced", label: "Balanced", recommended: true },
        { id: "speed", label: "Speed" },
      ],
    },
    {
      id: "include",
      kind: "multiple",
      prompt: "What should I include?",
      options: [
        { id: "research", label: "Research" },
        { id: "flows", label: "User flows" },
      ],
    },
    { id: "deadline", kind: "text", prompt: "When is it due?" },
  ],
};

const radios = (card) => [...card.host.querySelectorAll('[role="radio"]')];
const checkboxes = (card) => [...card.host.querySelectorAll('[role="checkbox"]')];

test("a question card labels the recommended option and picks nothing for the user", async (t) => {
  const card = await mountCard(t, PLAN);
  assert.match(card.host.textContent, /What are you optimizing for\?/);
  assert.match(card.host.textContent, /1\/3/);
  assert.deepEqual(
    radios(card).map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    [
      ["Balanced (Recommended)", "false"],
      ["Speed", "false"],
    ]
  );
  assert.deepEqual(card.entry().draft, {});
});

test("a pick shows, then moves on; the step and selections survive a remount", async (t) => {
  const card = await mountCard(t, PLAN);
  await card.click(radios(card)[1]);
  assert.equal(radios(card)[1].getAttribute("aria-checked"), "true", "the pick shows first");
  assert.equal(card.entry().step, 0);
  await card.wait(260);
  assert.equal(card.entry().step, 1);
  assert.match(card.host.textContent, /What should I include\?/);

  await card.click(checkboxes(card)[1]);
  await card.remount();
  assert.match(card.host.textContent, /2\/3/);
  assert.deepEqual(
    checkboxes(card).map((box) => box.getAttribute("aria-checked")),
    ["false", "true"]
  );
  await card.click(card.button("Previous question"));
  assert.equal(radios(card)[1].getAttribute("aria-checked"), "true");
});

test("‹ during the pause keeps the pick but stays on the question", async (t) => {
  const card = await mountCard(t, PLAN);
  await card.click(card.button("Next question"));
  await card.click(card.button("Previous question"));
  await card.click(radios(card)[0]);
  await card.click(card.button("Next question"));
  await card.click(card.button("Previous question"));
  await card.wait(260);
  assert.equal(card.entry().step, 0, "the pending move on was dropped");
  assert.equal(card.entry().draft.goal, "balanced");
});

test("Continue moves on from checkboxes, and ↑ on the last question submits once", async (t) => {
  const card = await mountCard(t, PLAN);
  await card.click(radios(card)[0]);
  await card.wait(260);
  await card.click(checkboxes(card)[0]);
  await card.click(card.button("Continue"));
  assert.match(card.host.textContent, /When is it due\?/);

  const submit = card.button("Submit");
  assert.equal(submit.disabled, true, "nothing to send yet");
  await card.type(card.host.querySelector("input"), "Friday");
  assert.equal(card.button("Submit").disabled, false);
  await card.click(card.button("Submit"));
  assert.deepEqual(card.results, [
    {
      status: "answered",
      answers: { goal: "balanced", include: ["research"], deadline: "Friday" },
    },
  ]);
  assert.equal(card.host.textContent, "", "an answered card gives way to its step");
});

test("Esc in a question card dismisses it, and never reaches the window", async (t) => {
  const card = await mountCard(t, PLAN);
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  await card.press(radios(card)[0], "Escape");
  assert.equal(reachedWindow, 0);
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
});

test("Esc on a connection card stays in the card and leaves it waiting", async (t) => {
  const card = await mountCard(t, { kind: "connection", target: "slack", reason: "To post it" });
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  await card.press(card.button("Yes"), "Escape");
  assert.equal(reachedWindow, 0);
  assert.equal(card.entry().state, "pending");
});

test("a connection card runs the real connect on Yes, and X dismisses it", async (t) => {
  const connects = [];
  const card = await mountCard(
    t,
    { kind: "connection", target: "slack", reason: "So I can post it" },
    {
      connectorConnect: (target) => {
        connects.push(target);
        return new Promise(() => {});
      },
      connectorCancelConnect: async (target) => connects.push(`cancel:${target}`),
    }
  );
  assert.match(card.host.textContent, /Connect Slack/);
  assert.match(card.host.textContent, /So I can post it/);
  assert.ok(card.host.querySelector("img"), "the service's logo");

  await card.click(card.button("Yes"));
  assert.deepEqual(connects, ["slack"]);
  assert.equal(card.button("Yes"), undefined, "never claims it connected; Yes goes while it runs");
  assert.match(card.host.textContent, /Finish connecting in your browser/);

  await card.click(card.button("Cancel"));
  assert.deepEqual(connects, ["slack", "cancel:slack"]);
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
});

test("Allow captures the screen and says so while it does", async (t) => {
  const card = await mountCard(
    t,
    { kind: "access", resource: "screen", reason: "To read the error" },
    {
      checkScreenRecordingAccess: async () => ({ granted: true }),
      captureScreenContext: () => new Promise(() => {}),
    }
  );
  assert.match(card.host.textContent, /Allow access to your screen\?/);
  assert.match(card.host.textContent, /To read the error/);
  await card.click(card.button("Allow"));
  assert.equal(card.button("Capturing…").disabled, true);
});

test("Not now on an access card is a refusal", async (t) => {
  const card = await mountCard(t, { kind: "access", resource: "screen", reason: "r" });
  await card.click(card.button("Not now"));
  assert.deepEqual(card.results, [{ status: "declined" }]);
});

test("Open Settings, then Done checks again before the task goes on", async (t) => {
  const opened = [];
  const card = await mountCard(
    t,
    {
      kind: "settings",
      target: "integrations.connectors",
      message: "Connect Linear in Settings.",
      technicalDetails: "linear: not connected",
    },
    {
      openSettingsSection: async (target) => opened.push(target),
      connectorStatus: async () => [],
    }
  );
  assert.equal(card.button("I'm done"), undefined, "Done only once Settings opened");
  const details = card.host.querySelector("details");
  assert.equal(details.open, false);
  await card.click(details.querySelector("summary"));
  assert.equal(details.open, true);
  assert.match(details.textContent, /linear: not connected/);

  await card.click(card.button("Open Settings"));
  assert.deepEqual(opened, ["integrations.connectors"]);
  await card.click(card.button("I'm done"));
  await card.wait(0);
  assert.deepEqual(card.results, [{ status: "done", ready: false }]);
});

test("Esc in the settings card dismisses it, and never reaches the window", async (t) => {
  const card = await mountCard(t, { kind: "settings", target: "llms", message: "Add a key" });
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  await card.press(card.button("Open Settings"), "Escape");
  assert.equal(reachedWindow, 0);
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
});

test("an API key is masked, reaches the saver only, and leaves just “key saved”", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  const input = card.host.querySelector("input");
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("autocomplete"), "off");
  assert.equal(input.getAttribute("dir"), "ltr");
  assert.equal(input.getAttribute("placeholder"), "Paste or write here");
  assert.match(
    input.className,
    /\binput-inline\b/,
    "styled by the card, not the app's global field"
  );
  assert.equal(card.button("Save").disabled, true);

  await card.type(input, "sk-qa-fake-not-a-real-key-123");
  assert.doesNotMatch(JSON.stringify(card.store.useAgentInteractionStore.getState()), /sk-qa/);
  assert.equal(input.getAttribute("value"), null, "never copied into the value attribute");
  assert.doesNotMatch(card.host.innerHTML, /sk-qa/, "nor anywhere else in the page");
  assert.equal(card.button("Save").disabled, false);

  await card.click(card.button("Save"));
  // The saver loads the settings store on first use.
  for (let i = 0; i < 400 && card.results.length === 0; i += 1) await card.wait(25);
  assert.deepEqual(card.savedKeys, ["sk-qa-fake-not-a-real-key-123"]);
  assert.deepEqual(card.results, [{ status: "saved" }]);
  assert.doesNotMatch(JSON.stringify(card.store.useAgentInteractionStore.getState()), /sk-qa/);
  assert.equal(card.host.textContent, "OpenAI key saved");
  assert.doesNotMatch(card.host.innerHTML, /sk-qa/, "the key is nowhere in the page");
});

test("a typed key is lost on a remount rather than kept anywhere", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  await card.type(card.host.querySelector("input"), "sk-qa-fake-remount");
  await card.remount();
  assert.equal(card.host.querySelector("input").value, "");
  assert.doesNotMatch(JSON.stringify(card.store.useAgentInteractionStore.getState()), /sk-qa/);
});

test("Esc in the key field dismisses the card without saving", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  const input = card.host.querySelector("input");
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  await card.type(input, "sk-qa-fake-esc");
  await card.press(input, "Escape");
  assert.equal(reachedWindow, 0);
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
  assert.deepEqual(card.savedKeys, []);
});

test("a key card that appears in a focused window takes the keyboard from an empty composer", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  const { document } = card.happyWindow;
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  document.hasFocus = () => true;
  await card.remount();
  // Compared by identity: a failed deep-equal of two DOM nodes inspects the whole document.
  assert.ok(document.activeElement === card.host.querySelector("input"));
});

test("a key card never takes the keyboard from a message being typed", async (t) => {
  const card = await mountCard(t, { kind: "apiKey", provider: "openai", providerName: "OpenAI" });
  const { document } = card.happyWindow;
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.value = "and also check";
  composer.focus();
  document.hasFocus = () => true;
  await card.remount();
  assert.ok(document.activeElement === composer, "the next keystrokes still go to the message");
});

test("Esc right after a question moves on still dismisses the card", async (t) => {
  const card = await mountCard(t, PLAN);
  const { document } = card.happyWindow;
  let reachedWindow = 0;
  card.happyWindow.addEventListener("keydown", () => (reachedWindow += 1));
  // A click focuses the option, which goes away with its question.
  radios(card)[1].focus();
  await card.click(radios(card)[1]);
  await card.wait(260);
  assert.equal(card.entry().step, 1);
  assert.ok(card.host.contains(document.activeElement), "the keyboard stays in the card");
  assert.ok(document.activeElement === checkboxes(card)[0], "on the next question's first option");
  await card.press(document.activeElement, "Escape");
  assert.equal(reachedWindow, 0);
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
});

test("a window given the keyboard with nothing focused puts it in the card", async (t) => {
  const card = await mountCard(t, { kind: "settings", target: "llms", message: "Add a key" });
  const { document } = card.happyWindow;
  // The window lost the keyboard (the user went to another app), then gets it back.
  document.activeElement?.blur();
  assert.ok(document.activeElement === document.body);
  await React.act(async () => card.happyWindow.dispatchEvent(new card.happyWindow.Event("focus")));
  assert.ok(document.activeElement === card.host.querySelector("[data-interaction-card]"));
  await card.press(document.activeElement, "Escape");
  assert.deepEqual(card.results, [{ status: "cancelled" }]);
});

test("Continue waits for a pick", async (t) => {
  const card = await mountCard(t, PLAN);
  await card.click(card.button("Next question"));
  assert.equal(card.button("Continue").disabled, true);
  await card.click(checkboxes(card)[0]);
  assert.equal(card.button("Continue").disabled, false);
});

test("a connect card says what connecting is for when the model doesn't", async (t) => {
  const card = await mountCard(t, { kind: "connection", target: "google" });
  assert.match(card.host.textContent, /I can check your availability and suggest times\./);
});

test("a connect that didn't happen is worded as the service's Settings row words it", async (t) => {
  const card = await mountCard(
    t,
    { kind: "connection", target: "slack" },
    { connectorConnect: async () => ({ status: "failed", errorCode: "oauth_denied" }) }
  );
  await card.click(card.button("Yes"));
  await card.wait(0);
  assert.match(card.host.textContent, /Slack wasn't connected because access wasn't allowed\./);
});

test("a card for any calendar has a translated title", async (t) => {
  const card = await mountCard(t, { kind: "connection", target: "calendar" });
  await React.act(async () => card.i18n.changeLanguage("de"));
  assert.match(card.host.textContent, /Kalender verbinden/);
  assert.doesNotMatch(card.host.textContent, /a calendar/);
});

test("a question waiting under the key of a settled answer card shows instead of it", async (t) => {
  // After Retry, the Slack picker asks where to send under the same key.
  const card = await mountCard(t, {
    kind: "questions",
    questions: [
      {
        id: "destination",
        kind: "single",
        prompt: "Where should it go?",
        options: [
          { id: "#launch-2", label: "#launch-2" },
          { id: "#launch-old", label: "#launch-old" },
        ],
      },
    ],
  });
  const approvals = await card.vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  await React.act(async () =>
    approvals.useConnectorApprovalStore.setState({
      entries: {
        "m1::c1": {
          key: "m1::c1",
          messageId: "m1",
          toolCallId: "c1",
          actionId: "a1",
          connectorId: "slack",
          preview: {
            verbKey: "slackPost",
            destinationLabel: "#launch",
            accountLabel: "QA",
            body: "hi",
          },
          draft: { body: "hi" },
          state: "not_sent",
        },
      },
    })
  );
  assert.equal(radios(card).length, 2, "the picker's options");
  assert.equal(card.host.querySelector("[data-approval-card]"), null);
  t.after(() => approvals.useConnectorApprovalStore.setState({ entries: {} }));
});
