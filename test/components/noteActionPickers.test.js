const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// i18n is not initialized, so labels render as raw keys or their default values.

const action = (overrides) => ({
  id: 1,
  client_id: "client",
  kind: "action",
  name: "Action",
  description: "",
  prompt: "Do it.",
  sections: null,
  output: "chat",
  icon: "sparkles",
  is_builtin: 0,
  sort_order: 0,
  translation_key: null,
  ...overrides,
});

const FOLLOW_UP = action({
  id: 2,
  client_id: "notes.actions.builtin.followUpEmail",
  name: "Follow-up email",
  translation_key: "notes.actions.builtin.followUpEmail",
});
const SHORTEN = action({ id: 3, client_id: "shorten", name: "Shorten", output: "summary" });

async function load(t, path, initialStorage) {
  installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-note-action-pickers-" });
  return (await vite.ssrLoadModule(path)).default;
}

// Every element a component returned when rendered inside a harness, without mounting it.
function renderTree(Component, props) {
  let tree = null;
  function Harness() {
    tree = Component(props);
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return tree;
}

function collect(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (!node.props) return out;
  out.push(node);
  collect(node.props.children, out);
  return out;
}

test("the ask-bar picker runs the follow-up email by default, even if a template was remembered", async (t) => {
  // Before templates split off, the remembered id could point at one.
  const ActionPicker = await load(t, "/components/notes/ActionPicker.tsx", {
    askBarActionId: "99",
  });
  const html = renderToStaticMarkup(
    createElement(ActionPicker, {
      actions: [SHORTEN, FOLLOW_UP],
      onRunAction: () => {},
      onManageActions: () => {},
      hasSummary: true,
      isSummaryBusy: false,
      isChatBusy: false,
    })
  );
  assert.match(html, /aria-label="notes\.actions\.runAction"[^>]*>.*Follow-up email<\/span>/);
});

test("a summary action can't run on a note with no summary to edit", async (t) => {
  const ActionPicker = await load(t, "/components/notes/ActionPicker.tsx", {
    askBarActionId: String(SHORTEN.id),
  });
  const html = renderToStaticMarkup(
    createElement(ActionPicker, {
      actions: [SHORTEN, FOLLOW_UP],
      onRunAction: () => {},
      onManageActions: () => {},
      hasSummary: false,
      isSummaryBusy: false,
      isChatBusy: false,
    })
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="notes\.actions\.runAction"/);
});

test("the sidebar chat offers the note's chat actions, and Generate summary writes the summary", async (t) => {
  const EmbeddedChat = await load(t, "/components/notes/EmbeddedChat.tsx");
  const ran = [];
  const props = {
    mode: "sidebar",
    onModeChange: () => {},
    messages: [],
    onTextSubmit: (text) => ran.push(["chat", text]),
    onCancel: () => {},
    chatActions: [FOLLOW_UP],
    onRunChatAction: (a) => ran.push(["action", a.name]),
    onGenerateSummary: () => ran.push(["summary"]),
  };

  const idle = collect(renderTree(EmbeddedChat, { ...props, agentState: "idle" }));
  const pills = idle.filter((node) => node.type === "button" && node.props.onMouseDown);
  assert.deepEqual(
    pills.map((pill) => pill.key),
    ["summary", FOLLOW_UP.client_id]
  );
  for (const pill of pills) pill.props.onClick();
  assert.deepEqual(ran, [["summary"], ["action", "Follow-up email"]]);

  const streaming = collect(renderTree(EmbeddedChat, { ...props, agentState: "streaming" })).filter(
    (node) => node.type === "button" && node.props.onMouseDown
  );
  assert.equal(streaming.length, 2);
  for (const pill of streaming) {
    assert.equal(pill.props.disabled, true, "no quick action starts while a reply streams");
  }
});
