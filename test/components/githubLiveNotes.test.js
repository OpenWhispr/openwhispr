const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function dispatch(element, type) {
  element.dispatchEvent({
    type,
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

const click = (element) => dispatch(element, "click");

// React's change event reads the new value from the element, then an input event.
function type(element, value) {
  element.value = value;
  dispatch(element, "input");
}

function button(root, label) {
  const found = findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

function field(root, labelKey) {
  const found = findElement(root, (element) => element.getAttribute?.("aria-label") === labelKey);
  assert.ok(found, `field ${labelKey} is rendered`);
  return found;
}

const NOTE_KEY = "connectors.approval.github.notes.mentions";
const note = (mentions) => `${NOTE_KEY}${JSON.stringify({ mentions })}`;

const ISSUE = {
  verbKey: "issue",
  destinationLabel: "acme/api",
  accountLabel: "@dana",
  body: "Login times out. cc @alice and @acme/infra",
  fields: { title: "Timeout on login", body: "Login times out. cc @alice and @acme/infra" },
};

// One card on the real approval store, with the translation keys (and their
// values) as the text.
async function mountCard(t, { connectorId, preview, language = "en" }) {
  let root = null;
  let store;
  let key;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // A card left pending keeps the approval timer, and the process, alive.
  t.after(() => {
    if (store?.useConnectorApprovalStore.getState().entries[key]?.state === "pending") {
      store.cancelApproval(key);
    }
  });
  installBrowserGlobals(t, {
    window: { electronAPI: { connectorCancel: async () => ({ cancelled: true }) } },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-github-live-notes-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/i18n": `export default { t: (key) => key };`,
      "react-i18next": `
        const t = (key, options) => (options ? key + JSON.stringify(options) : key);
        export const useTranslation = () => ({ t, i18n: { language: ${JSON.stringify(language)} } });
      `,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  store = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const { ApprovalCard } = await vite.ssrLoadModule("/components/chat/ApprovalCard.tsx");
  store.useConnectorApprovalStore.setState({ entries: {} });
  key = store.approvalKey("m1", "call-1");
  void store.requestApproval(
    {
      messageId: "m1",
      toolCallId: "call-1",
      signal: new AbortController().signal,
      onApprovalRequested() {},
      onHoldDelivery() {},
      claimTurnSlot: () => true,
      releaseTurnSlot() {},
    },
    { actionId: "a1", connectorId, preview }
  );

  function Harness() {
    const entry = store.useConnectorApprovalStore((state) => state.entries[key]);
    return entry ? React.createElement(ApprovalCard, { entry }) : null;
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return container;
}

test("a GitHub issue card says who its mentions will notify", async (t) => {
  const container = await mountCard(t, { connectorId: "github", preview: ISSUE });
  assert.ok(container.textContent.includes(note("@alice and @acme/infra")));
});

test("the note follows the user's edits: added, changed and gone", async (t) => {
  const container = await mountCard(t, { connectorId: "github", preview: ISSUE });
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  const body = () => field(container, "connectors.approval.issue.bodyLabel");

  await React.act(async () => type(body(), "Ask @bob instead. Also @Bob and @carol."));
  assert.ok(container.textContent.includes(note("@bob and @carol")));
  assert.equal(container.textContent.includes("@alice"), false);

  await React.act(async () => type(body(), "Nobody to ping; see `@alice` in the log."));
  assert.equal(container.textContent.includes(NOTE_KEY), false);

  // A mention in the title notifies too.
  await React.act(async () =>
    type(field(container, "connectors.approval.issue.titleLabel"), "Ping @dana")
  );
  assert.ok(container.textContent.includes(note("@dana")));
});

test("the mentions are listed the way the UI language lists names", async (t) => {
  const preview = {
    ...ISSUE,
    fields: { title: "Timeout", body: "cc @alice, @bob and @carol" },
  };
  const german = await mountCard(t, { connectorId: "github", preview, language: "de" });
  assert.ok(german.textContent.includes(note("@alice, @bob und @carol")));
});

test("a language tag Intl can't read falls back to a comma list", async (t) => {
  const container = await mountCard(t, {
    connectorId: "github",
    preview: ISSUE,
    language: "en_US",
  });
  assert.ok(container.textContent.includes(note("@alice, @acme/infra")));
});

test("the fields being edited are described by the note, and only while there is one", async (t) => {
  const container = await mountCard(t, { connectorId: "github", preview: ISSUE });
  await React.act(async () => click(button(container, "connectors.approval.edit")));
  const title = () => field(container, "connectors.approval.issue.titleLabel");
  const body = () => field(container, "connectors.approval.issue.bodyLabel");

  const notesId = body().getAttribute("aria-describedby");
  assert.ok(notesId, "the body names the note");
  assert.equal(title().getAttribute("aria-describedby"), notesId);
  const notes = findElement(container, (element) => element.getAttribute?.("id") === notesId);
  assert.ok(notes, "the id belongs to the rendered note");
  assert.ok(notes.textContent.includes(NOTE_KEY));

  // An empty title is described by what blocks Send as well as by the note.
  await React.act(async () => type(title(), ""));
  const [problemsId, ...rest] = title().getAttribute("aria-describedby").split(" ");
  assert.deepEqual(rest, [notesId]);
  assert.notEqual(problemsId, notesId);
  assert.equal(title().getAttribute("aria-invalid"), "true");
  await React.act(async () => type(title(), "Timeout"));

  await React.act(async () => type(body(), "Nobody to ping."));
  assert.equal(body().getAttribute("aria-describedby"), null);
  assert.equal(title().getAttribute("aria-describedby"), null);
});

test("the note speaks of Send, so a cancelled card no longer shows it", async (t) => {
  const container = await mountCard(t, { connectorId: "github", preview: ISSUE });
  assert.ok(container.textContent.includes(note("@alice and @acme/infra")));

  await React.act(async () => click(button(container, "connectors.approval.cancel")));

  assert.ok(container.textContent.includes("connectors.approval.cancelled"));
  assert.equal(container.textContent.includes(NOTE_KEY), false);
});

test("a GitHub comment card counts mentions outside code only", async (t) => {
  const text = "Thanks @erin!\n```\n@not-me\n```\nmail ops@acme.test";
  const container = await mountCard(t, {
    connectorId: "github",
    preview: {
      verbKey: "comment",
      destinationLabel: "acme/api#45",
      accountLabel: "@dana",
      body: text,
      fields: { body: text },
    },
  });
  assert.ok(container.textContent.includes(note("@erin")));
});

test("a card from another connector never gets the GitHub note", async (t) => {
  // Linear lays out the same issue card.
  const linear = await mountCard(t, { connectorId: "linear", preview: ISSUE });
  assert.equal(linear.textContent.includes(NOTE_KEY), false);
});

test("Slack and Gmail cards are unchanged by the GitHub note", async (t) => {
  const slack = await mountCard(t, {
    connectorId: "slack",
    preview: {
      verbKey: "slackPost",
      destinationLabel: "#eng",
      accountLabel: "chad",
      body: "Heads up @alice",
    },
  });
  assert.equal(slack.textContent.includes(NOTE_KEY), false);
});

test("a Gmail card with an @ in its body gets no GitHub note", async (t) => {
  const fields = { to: ["josh@acme.test"], cc: [], subject: "Hi @team", body: "cc @alice" };
  const gmail = await mountCard(t, {
    connectorId: "gmail",
    preview: {
      verbKey: "email",
      destinationLabel: "josh@acme.test",
      accountLabel: "you@example.test",
      body: fields.body,
      fields,
    },
  });
  assert.equal(gmail.textContent.includes(NOTE_KEY), false);
});
