const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

// The answer card in happy-dom over the real store; i18n is not initialized,
// so labels are their keys.
async function mountCard(t, entry, electronAPI = {}) {
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
  store.useConnectorApprovalStore.setState({ entries: { [entry.key]: entry } });
  function Harness() {
    const current = store.useConnectorApprovalStore((state) => state.entries[entry.key]);
    return React.createElement(ApprovalCard, { entry: current });
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

test("a Slack card shows its channel and sender read-only; only the message is edited", async (t) => {
  const card = await mountCard(t, SLACK);
  const text = card.host.textContent;
  assert.match(text, /connectors\.approval\.slack\.channelLabel/);
  assert.match(text, /connectors\.approval\.slack\.destination/);
  assert.match(text, /connectors\.approval\.slack\.asLabel/);
  assert.match(text, /pratham/);
  const fields = card.host.querySelectorAll("input, textarea");
  assert.equal(fields.length, 1, "nothing but the message can be edited");
  assert.equal(fields[0].tagName, "TEXTAREA");
  assert.equal(fields[0].value, SLACK.draft.body);
  assert.match(
    fields[0].className,
    /\binput-inline\b/,
    "styled by the card, not the app's global field"
  );
  assert.ok(card.host.querySelector('img[aria-hidden="true"]'), "Slack's logo by the channel");
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
