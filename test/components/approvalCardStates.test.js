const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The answer card in happy-dom over the real store; i18n is not initialized,
// so labels are their keys. `placement` shows it in a voice call.
async function mountCard(t, entry, electronAPI = {}, placement = null) {
  let root = null;
  t.after(() => root && React.act(async () => root.unmount()));
  const happyWindow = await installHappyDom(t);
  const calls = { clipboard: [], connect: [], commit: [], cancel: [], cancelConnect: [] };
  happyWindow.electronAPI = {
    writeClipboard: async (text) => {
      calls.clipboard.push(text);
      return { success: true };
    },
    connectorCommit: async (actionId, edits) => {
      calls.commit.push({ actionId, edits });
      return { state: "sent" };
    },
    connectorCancel: async (actionId, reason) => calls.cancel.push({ actionId, reason }),
    connectorCancelConnect: async (target) => calls.cancelConnect.push(target),
    ...electronAPI,
  };
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-approval-states-" });
  const store = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  const { CallCardContext } = await vite.ssrLoadModule("/components/chat/callCardContext.ts");
  store.useConnectorApprovalStore.setState({ entries: { [entry.key]: entry } });
  function Harness() {
    const current = store.useConnectorApprovalStore((state) => state.entries[entry.key]);
    return React.createElement(
      CallCardContext.Provider,
      { value: placement },
      React.createElement(ApprovalCard, { entry: current })
    );
  }
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  await React.act(async () => root.render(React.createElement(Harness)));
  const button = (label) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent === label);
  const set = (patch) =>
    React.act(async () =>
      store.useConnectorApprovalStore.setState((state) => ({
        entries: { ...state.entries, [entry.key]: { ...state.entries[entry.key], ...patch } },
      }))
    );
  return { host, store, calls, button, set };
}

const SLACK = {
  key: "m1::c1",
  messageId: "m1",
  toolCallId: "c1",
  actionId: "a1",
  connectorId: "slack",
  preview: {
    verbKey: "slackPost",
    destinationLabel: "#design",
    accountLabel: "pratham",
    workspaceLabel: "OpenWhispr",
    body: "Quick heads-up: the homepage draft is ready.",
  },
  draft: { body: "Quick heads-up: the homepage draft is ready." },
  state: "pending",
};

test("a Slack card with no channel to choose shows its workspace, channel and sender read-only", async (t) => {
  const card = await mountCard(t, SLACK);
  const text = card.host.textContent;
  assert.match(text, /connectors\.approval\.slack\.workspaceLabel/);
  assert.match(text, /OpenWhispr/);
  assert.match(text, /connectors\.approval\.slack\.channelLabel/);
  assert.match(text, /#design/);
  assert.match(text, /connectors\.approval\.slack\.asLabel/);
  assert.match(text, /pratham/);
  assert.equal(card.host.querySelector('[data-approval-field="channel"]'), null, "no picker");
  const fields = card.host.querySelectorAll("input, textarea");
  assert.equal(fields.length, 1, "nothing but the message can be edited");
  assert.equal(fields[0].tagName, "TEXTAREA");
  assert.equal(fields[0].value, SLACK.draft.body);
  assert.match(
    fields[0].className,
    /\binput-inline\b/,
    "styled by the card, not the app's global field"
  );
  assert.ok(card.host.querySelector('img[aria-hidden="true"]'), "Slack's logo by the workspace");

  // A DM or thread reply keeps its destination: a channel edit never reaches Send.
  card.store.updateApprovalDraft(SLACK.key, { channel: { id: "C0OTHER01", label: "#other" } });
  await React.act(async () => card.button("connectors.approval.send").click());
  assert.deepEqual(card.calls.commit, [{ actionId: "a1", edits: { body: SLACK.draft.body } }]);
});

// A channel post: main lists the bound login's channels for this card's action.
const CHANNELS = [
  { id: "C0GENERAL", label: "#general" },
  { id: "C0DESIGN1", label: "#design" },
  { id: "C0ENGINEE", label: "#engineering" },
  { id: "C0PRODUCT", label: "#product" },
  { id: "C0DREVIEW", label: "#design-reviews" },
  { id: "C0DSYSTEM", label: "#design-system" },
];
const CHANNEL_POST = { ...SLACK, preview: { ...SLACK.preview, channel: "C0DESIGN1" } };

// What Radix's popover reads from the global scope, beyond the card's own.
function installPopoverGlobals(t, view) {
  const names = [
    "getComputedStyle",
    "HTMLInputElement",
    "MutationObserver",
    "CustomEvent",
    "FocusEvent",
    "PointerEvent",
  ];
  const originals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of names) {
    const value = name === "getComputedStyle" ? view.getComputedStyle.bind(view) : view[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

async function openChannelMenu(t, entry = CHANNEL_POST, electronAPI = {}) {
  const asked = [];
  const card = await mountCard(t, entry, {
    connectorDestinations: async (actionId) => {
      asked.push(actionId);
      return { status: "ok", destinations: CHANNELS };
    },
    ...electronAPI,
  });
  installPopoverGlobals(t, card.host.ownerDocument.defaultView);
  await React.act(async () => card.host.querySelector('[data-approval-field="channel"]').click());
  const menu = card.host.ownerDocument.querySelector('[role="listbox"]');
  const options = () =>
    [...menu.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  return { ...card, asked, menu, options };
}

test("a channel post's picker lists the channels main read for this card, with the current one checked", async (t) => {
  const card = await openChannelMenu(t);
  assert.deepEqual(card.asked, ["a1"], "asked for this card's action, so its bound login");
  assert.deepEqual(
    card.options(),
    CHANNELS.map((channel) => channel.label)
  );
  const selected = card.menu.querySelector('[aria-selected="true"]');
  assert.equal(selected.textContent, "#design");
  assert.ok(selected.querySelector("svg"), "a checkmark on the current channel");
  assert.equal(
    card.host.ownerDocument.querySelector(
      'input[aria-label="connectors.approval.slack.findChannel"]'
    ).placeholder,
    "connectors.approval.slack.findChannel"
  );
});

test("the channel search narrows the list, and a pick changes the card and what Send commits", async (t) => {
  const card = await openChannelMenu(t);
  const search = card.host.ownerDocument.querySelector(
    'input[aria-label="connectors.approval.slack.findChannel"]'
  );
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(search), "value").set.call(search, "des");
    search.dispatchEvent(new search.ownerDocument.defaultView.Event("input", { bubbles: true }));
  });
  assert.deepEqual(card.options(), ["#design", "#design-reviews", "#design-system"]);

  const reviews = [...card.menu.querySelectorAll('[role="option"]')].find(
    (option) => option.textContent === "#design-reviews"
  );
  await React.act(async () => reviews.click());
  const trigger = card.host.querySelector('[data-approval-field="channel"]');
  assert.equal(trigger.textContent, "#design-reviews");
  assert.deepEqual(card.store.useConnectorApprovalStore.getState().entries["m1::c1"].draft, {
    body: SLACK.draft.body,
    channel: { id: "C0DREVIEW", label: "#design-reviews" },
  });

  await React.act(async () => card.button("connectors.approval.send").click());
  assert.deepEqual(card.calls.commit, [
    { actionId: "a1", edits: { body: SLACK.draft.body, channel: "C0DREVIEW" } },
  ]);
});

test("no channel is listed when main can't read them, and none is offered after the card leaves pending", async (t) => {
  const card = await openChannelMenu(t, CHANNEL_POST, {
    connectorDestinations: async () => ({ status: "unavailable", reason: "not_found" }),
  });
  assert.deepEqual(card.options(), []);
  assert.match(card.menu.textContent, /connectors\.approval\.slack\.channelsUnavailable/);

  await card.set({ state: "failed", awaitingRetry: true, errorCode: "rate_limited" });
  assert.equal(card.host.querySelector('[data-approval-field="channel"]'), null);
});

const EMAIL_FIELDS = { to: ["sam@example.test"], cc: [], subject: "Review", body: "Hi Sam" };
const EMAIL = {
  key: "m1::c2",
  messageId: "m1",
  toolCallId: "c2",
  actionId: "a2",
  connectorId: "gmail",
  preview: {
    verbKey: "email",
    destinationLabel: "sam@example.test",
    accountLabel: "me@example.test",
    body: EMAIL_FIELDS.body,
    fields: EMAIL_FIELDS,
  },
  draft: { fields: EMAIL_FIELDS, body: EMAIL_FIELDS.body },
  state: "pending",
};

test("in a call an email card has Copy all and Send in its title row, and no sender or Cancel", async (t) => {
  const card = await mountCard(t, EMAIL, {}, "compact");
  const title = card.host.querySelector("[data-approval-card]").firstElementChild;
  assert.match(title.textContent, /connectors\.approval\.email\.title/);
  assert.ok(title.contains(card.button("connectors.approval.email.copyAll")));
  assert.ok(title.contains(card.button("connectors.approval.send")));
  assert.doesNotMatch(card.host.textContent, /connectors\.approval\.email\.fromLabel/);
  assert.equal(card.button("connectors.approval.cancel"), undefined);

  await card.set({ state: "committing" });
  assert.ok(title.contains(card.button("connectors.approval.sending")), "Sending… stays there");
});

test("outside a call the email card keeps its sender and its actions at the foot", async (t) => {
  const card = await mountCard(t, EMAIL);
  const parts = [...card.host.querySelector("[data-approval-card]").children];
  assert.match(parts[0].textContent, /connectors\.approval\.email\.fromLabel/);
  assert.doesNotMatch(parts[0].textContent, /connectors\.approval\.email\.title/);
  assert.ok(parts.at(-1).contains(card.button("connectors.approval.send")));
  assert.ok(card.button("connectors.approval.cancel"));
});

test("Copy copies the message as it stands, and says so", async (t) => {
  const card = await mountCard(t, SLACK);
  await card.set({ draft: { body: "Edited heads-up" } });
  await React.act(async () => card.button("common.copy").click());
  assert.deepEqual(card.calls.clipboard, ["Edited heads-up"]);
  assert.ok(card.button("common.copied"));
});

test("a long message scrolls between the fixed destination and actions", async (t) => {
  const long = "A long paragraph.\n\n".repeat(60);
  const card = await mountCard(t, { ...SLACK, draft: { body: long } });
  const cardElement = card.host.querySelector("[data-approval-card]");
  const parts = [...cardElement.children];
  const bodyIndex = parts.findIndex((part) => part.hasAttribute("data-approval-body"));
  const body = parts[bodyIndex];
  assert.match(body.className, /overflow-y-auto/);
  assert.match(body.className, /max-h-/);
  assert.match(parts[0].textContent, /connectors\.approval\.slack\.channelLabel/, "header first");
  assert.match(parts.at(-1).textContent, /connectors\.approval\.send/, "actions last");
  assert.ok(bodyIndex > 0 && bodyIndex < parts.length - 1);
  assert.equal(body.querySelector("textarea").value, long);
});

test("Sending keeps the message, read-only, with Send turned into Sending… and no Cancel", async (t) => {
  const card = await mountCard(t, { ...SLACK, state: "committing" });
  assert.equal(card.host.querySelectorAll("textarea, input").length, 0);
  assert.match(card.host.textContent, /Quick heads-up/);
  const sending = card.button("connectors.approval.sending");
  assert.equal(sending.getAttribute("aria-disabled"), "true");
  assert.equal(card.button("connectors.approval.cancel"), undefined);
  assert.ok(card.button("common.copy"));
});

test("Sent keeps the message, with ✓ Sent, Copy and the link", async (t) => {
  const card = await mountCard(t, { ...SLACK, state: "sent", url: "https://slack.test/p/1" });
  assert.match(card.host.textContent, /Quick heads-up/);
  assert.match(card.host.textContent, /connectors\.approval\.sentLabel/);
  assert.ok(
    [...card.host.querySelectorAll("button")].some((element) =>
      element.textContent.trim().startsWith("connectors.approval.open")
    ),
    "the link to the sent message"
  );
  assert.ok(card.button("common.copy"));
  assert.equal(card.button("connectors.approval.send"), undefined);
  assert.equal(card.button("connectors.approval.cancel"), undefined);
});

test("a Slack reply sent outside its thread visibly reports the outcome and removes the thread promise", async (t) => {
  const threadNote = "connectors.approval.slack.notes.replyInThread";
  const card = await mountCard(t, {
    ...SLACK,
    preview: {
      ...SLACK.preview,
      notes: [
        { key: threadNote, values: { started: "1727200000000" } },
        { key: "connectors.approval.sentEarlier" },
      ],
    },
  });
  // Happy DOM has no layout; exclude screen-reader-only text from its visual text readout.
  const style = card.host.ownerDocument.createElement("style");
  style.textContent = ".sr-only { display: none; }";
  card.host.ownerDocument.head.append(style);
  assert.match(card.host.innerText, /connectors\.approval\.slack\.notes\.replyInThread/);

  await card.set({ state: "sent", outsideThread: true });

  assert.match(card.host.innerText, /connectors\.approval\.slack\.sentOutsideThread/);
  assert.doesNotMatch(card.host.innerText, /connectors\.approval\.slack\.notes\.replyInThread/);
  assert.match(card.host.innerText, /connectors\.approval\.sentEarlier/);
  assert.ok(card.button("common.copy"));
});

test("a failed send keeps the draft editable, with Retry and Cancel; settled, only Copy", async (t) => {
  const card = await mountCard(t, {
    ...SLACK,
    state: "failed",
    awaitingRetry: true,
    errorCode: "rate_limited",
  });
  assert.match(card.host.textContent, /connectors\.approval\.failed/);
  assert.equal(card.host.querySelectorAll("textarea").length, 1, "editable again");
  assert.ok(card.button("common.retry"));
  assert.ok(card.button("connectors.approval.cancel"));

  await card.set({ awaitingRetry: undefined });
  assert.equal(card.button("common.retry"), undefined, "nothing waits for a Retry any more");
  assert.equal(card.host.querySelectorAll("textarea").length, 0);
  assert.ok(card.button("common.copy"));
});

test("an unconfirmed send offers no Retry", async (t) => {
  const card = await mountCard(t, { ...SLACK, state: "unknown" });
  assert.equal(card.button("common.retry"), undefined);
  assert.equal(card.button("connectors.approval.send"), undefined);
  assert.ok(card.button("common.copy"));
});

test("Send that needs a connection asks in place of the actions; X goes back to the draft", async (t) => {
  const card = await mountCard(t, { ...SLACK, reconnect: "prompt" });
  assert.match(card.host.textContent, /connectors\.approval\.connectToSend/);
  assert.equal(card.button("connectors.approval.send"), undefined);
  assert.equal(card.host.querySelectorAll("textarea").length, 0, "the draft waits as it is");
  const dismiss = [...card.host.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === "agentMode.interactions.notNow"
  );
  await React.act(async () => dismiss.click());
  assert.ok(card.button("connectors.approval.send"));
});

test("after a reconnect as someone else, the card says who it now sends as", async (t) => {
  const card = await mountCard(t, {
    ...SLACK,
    preview: { ...SLACK.preview, accountLabel: "pratham-work" },
    notice: "identity_changed",
  });
  assert.match(card.host.textContent, /connectors\.approval\.identityChanged/);
  assert.ok(card.button("connectors.approval.send"));
});
