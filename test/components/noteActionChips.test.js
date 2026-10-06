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
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-note-action-chips-" });
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

test("the ask bar shows the first four actions as chips and every action under All actions", async (t) => {
  const ActionChips = await load(t, "/components/notes/ActionChips.tsx");
  const actions = [
    FOLLOW_UP,
    action({ id: 4, client_id: "todos", name: "Make to-dos" }),
    SHORTEN,
    action({ id: 5, client_id: "tldr", name: "Add TL;DR", output: "summary" }),
    action({ id: 6, client_id: "outline", name: "Create outline" }),
  ];
  const ran = [];
  const tree = collect(
    renderTree(ActionChips, {
      actions,
      canRun: (a) => a.output === "chat",
      onRunAction: (a) => ran.push(a.name),
      onManageActions: () => ran.push("manage"),
    })
  );

  const chips = tree.filter((node) => node.type === "button" && node.props.onClick);
  assert.deepEqual(
    chips.map((chip) => chip.key),
    ["2", "4", "3", "5"]
  );
  assert.deepEqual(
    chips.map((chip) => chip.props.disabled),
    [false, false, true, true],
    "a chip is disabled while its action can't run"
  );
  chips[0].props.onClick();

  const menuItems = tree.filter((node) => typeof node.type !== "string" && node.props.onClick);
  assert.equal(menuItems.length, actions.length + 1, "every action, then Manage Actions");
  menuItems.at(-2).props.onClick();
  menuItems.at(-1).props.onClick();
  assert.deepEqual(ran, ["Follow-up email", "Create outline", "manage"]);
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
    slashCommands: [{ id: "cmd", label: "Follow-up email", run: () => {} }],
  };

  const idle = collect(renderTree(EmbeddedChat, { ...props, agentState: "idle" }));
  const pills = idle.filter((node) => node.type === "button" && node.props.onMouseDown);
  assert.deepEqual(
    pills.map((pill) => pill.key),
    ["summary", FOLLOW_UP.client_id]
  );
  for (const pill of pills) pill.props.onClick();
  assert.deepEqual(ran, [["summary"], ["action", "Follow-up email"]]);
  const composer = idle.find((node) => node.props.variant === "sidebar");
  assert.equal(composer.props.slashCommands, props.slashCommands, "/ reaches the sidebar composer");

  const streaming = collect(renderTree(EmbeddedChat, { ...props, agentState: "streaming" })).filter(
    (node) => node.type === "button" && node.props.onMouseDown
  );
  assert.equal(streaming.length, 2);
  for (const pill of streaming) {
    assert.equal(pill.props.disabled, true, "no quick action starts while a reply streams");
  }
});
