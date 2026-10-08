const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

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
  renderToStaticMarkup(React.createElement(Harness));
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

const ACTIONS = [
  FOLLOW_UP,
  action({ id: 4, client_id: "todos", name: "Create to-dos" }),
  SHORTEN,
  action({ id: 5, client_id: "tldr", name: "Add TL;DR", output: "summary" }),
  action({ id: 6, client_id: "outline", name: "Create outline" }),
];

test("the open chat shows the first four actions as chips that run on click, disabled while they can't", async (t) => {
  const ActionChips = await load(t, "/components/notes/ActionChips.tsx");
  const ran = [];
  const props = {
    actions: ACTIONS,
    canRun: (a) => a.output === "chat",
    onRunAction: (a) => ran.push(a.name),
    onManageActions: () => ran.push("manage"),
  };
  const tree = collect(renderTree(ActionChips, props));

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
  assert.deepEqual(ran, ["Follow-up email"]);
});

test("hovering a chip shows what its action does above the row", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-action-chips-hover-",
    // Radix needs real layout; the menu isn't under test here.
    mockModules: {
      "/ui/dropdown-menu": `
        export const DropdownMenu = ({ children }) => children;
        export const DropdownMenuTrigger = ({ children }) => children;
        export const DropdownMenuContent = () => null;
      `,
    },
  });
  const ActionChips = (await vite.ssrLoadModule("/components/notes/ActionChips.tsx")).default;
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  let ran = 0;
  const todos = action({
    id: 4,
    client_id: "todos",
    name: "Create to-dos",
    description: "List every to-do",
  });
  await React.act(async () =>
    root.render(
      React.createElement(ActionChips, {
        actions: [FOLLOW_UP, todos],
        // A disabled chip still shows what its action does.
        canRun: (a) => a !== FOLLOW_UP,
        onRunAction: () => ran++,
        onManageActions: () => {},
      })
    )
  );
  const chip = findElement(
    container,
    (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Create to-dos"
  );
  const description = () => findElement(container, (el) => el.textContent === "List every to-do");
  const pointer = (type) =>
    React.act(async () => chip.dispatchEvent({ type, bubbles: true, relatedTarget: null }));

  assert.equal(description(), null);
  await pointer("pointerover");
  assert.ok(description(), "the hovered action's description shows");

  const card = description().parentNode.parentNode;
  const followUpChip = findElement(container, (el) => el.tagName === "BUTTON");
  const strip = followUpChip.parentNode;
  const move = (from, to) =>
    React.act(async () =>
      from.dispatchEvent({ type: "pointerout", bubbles: true, relatedTarget: to })
    );
  await move(chip, strip);
  assert.ok(description(), "crossing the gap between chips keeps the card up");
  await move(strip, followUpChip);
  assert.equal(
    description(),
    null,
    "and the next chip, even a disabled one, swaps it to its own action"
  );
  assert.ok(card.textContent.trim().startsWith(followUpChip.textContent.trim()));
  assert.ok(
    findElement(container, (el) => el === card),
    "without remounting the card, so its entrance doesn't replay"
  );
  await move(followUpChip, null);
  assert.equal(
    findElement(container, (el) => el === card),
    null,
    "it goes once the pointer leaves the row"
  );

  await pointer("pointerover");
  await pointer("click");
  assert.equal(ran, 1);
  assert.equal(description(), null, "and once the action runs, so it can't cover the reply");
});

test("the docked chips lead with Generate summary, held back while a summary is being written", async (t) => {
  const ActionChips = await load(t, "/components/notes/ActionChips.tsx");
  const ran = [];
  const props = {
    actions: ACTIONS,
    canRun: () => true,
    onRunAction: (a) => ran.push(a.name),
    onManageActions: () => {},
    docked: true,
  };
  const buttons = (generateSummary) =>
    collect(renderTree(ActionChips, { ...props, generateSummary })).filter(
      (node) => node.type === "button" && node.props.onClick
    );

  const idle = buttons({ run: () => ran.push("summary"), disabled: false });
  assert.equal(idle.length, 5, "Generate summary, then the first four actions");
  idle[0].props.onClick();
  idle[1].props.onClick();
  assert.deepEqual(ran, ["summary", "Follow-up email"]);
  assert.equal(buttons({ run: () => {}, disabled: true })[0].props.disabled, true);
  assert.equal(buttons(undefined).length, 4, "no pill when the note has no template to run");

  // All actions (the menu's trigger) leads the docked row and opens toward the chips.
  const order = (docked) =>
    collect(renderTree(ActionChips, { ...props, docked }))
      .filter((node) => node.props.align || (node.type === "button" && node.props.onClick))
      .map((node) => node.props.align ?? "chip");
  assert.deepEqual(order(true).slice(0, 2), ["start", "chip"]);
  assert.deepEqual(order(false).slice(-2), ["chip", "end"], "the in-view chat keeps it last");
});

test("the action menu lists every action, then Manage Actions", async (t) => {
  const ActionMenuItems = await load(t, "/components/notes/ActionMenuItems.tsx");
  const ran = [];
  const menuItems = collect(
    renderTree(ActionMenuItems, {
      actions: ACTIONS,
      canRun: (a) => a.output === "chat",
      onRunAction: (a) => ran.push(a.name),
      onManageActions: () => ran.push("manage"),
    })
  ).filter((node) => typeof node.type !== "string" && node.props.onClick);

  assert.equal(menuItems.length, ACTIONS.length + 1, "every action, then Manage Actions");
  assert.deepEqual(
    menuItems.slice(0, -1).map((item) => item.props.disabled),
    [false, false, true, true, false]
  );
  menuItems.at(-2).props.onClick();
  menuItems.at(-1).props.onClick();
  assert.deepEqual(ran, ["Create outline", "manage"]);
});

test("the collapsed ask bar's picker runs the first action until one is picked, and remembers the pick", async (t) => {
  const ActionPicker = await load(t, "/components/notes/ActionPicker.tsx");
  const ran = [];
  const props = {
    actions: ACTIONS,
    canRun: (a) => a.output === "chat",
    onRunAction: (a) => ran.push(a.name),
    onManageActions: () => {},
  };
  const runButton = (tree) => tree.find((node) => node.type === "button" && node.props.onClick);

  const first = collect(renderTree(ActionPicker, props));
  assert.equal(runButton(first).props.disabled, false);
  runButton(first).props.onClick();
  assert.deepEqual(ran, ["Follow-up email"], "the first action until one is picked");

  const menu = first.find((node) => node.props.onManageActions);
  menu.props.onRunAction(SHORTEN);

  const next = collect(renderTree(ActionPicker, props));
  assert.equal(
    runButton(next).props.disabled,
    true,
    "a remounted picker remembers it, disabled while it can't run"
  );
});

test("picking from the picker makes its main button run that action at once", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-action-picker-",
    // Radix needs real layout; render the menu's items in place.
    mockModules: {
      "/ui/dropdown-menu": `
        import { createElement } from "react";
        export const DropdownMenu = ({ children }) => children;
        export const DropdownMenuTrigger = ({ children }) => children;
        export const DropdownMenuContent = ({ children }) => children;
        export const DropdownMenuItem = ({ children, onClick, disabled }) =>
          createElement("button", { onClick, disabled, "data-menu-item": "" }, children);
        export const DropdownMenuSeparator = () => null;
      `,
    },
  });
  const ActionPicker = (await vite.ssrLoadModule("/components/notes/ActionPicker.tsx")).default;
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  const ran = [];
  await React.act(async () =>
    root.render(
      React.createElement(ActionPicker, {
        actions: ACTIONS,
        canRun: () => true,
        onRunAction: (a) => ran.push(a.name),
        onManageActions: () => {},
      })
    )
  );
  const click = (el) => React.act(async () => el.dispatchEvent({ type: "click", bubbles: true }));
  const runButton = () =>
    findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        el.getAttribute("aria-label") === null &&
        el.getAttribute("data-menu-item") === null
    );

  await click(
    findElement(
      container,
      (el) =>
        el.getAttribute?.("data-menu-item") !== null &&
        el.textContent.trim().startsWith("Create outline")
    )
  );
  assert.equal(
    runButton().textContent.trim(),
    "Create outline",
    "the picker shows the picked action"
  );
  await click(runButton());
  assert.deepEqual(ran, ["Create outline", "Create outline"]);
});

test("the docked chat shows the note's chips between its messages and its composer", async (t) => {
  const EmbeddedChat = await load(t, "/components/notes/EmbeddedChat.tsx");
  const chips = React.createElement("div", { "data-chips": "" });
  const slashCommands = [{ id: "cmd", label: "Follow-up email", run: () => {} }];
  const tree = collect(
    renderTree(EmbeddedChat, {
      onClose: () => {},
      messages: [],
      noteConversations: [],
      activeConversationId: null,
      onSwitchConversation: () => {},
      onNewChat: () => {},
      agentState: "idle",
      onTextSubmit: () => {},
      onCancel: () => {},
      actionChips: chips,
      slashCommands,
    })
  );

  const order = tree.filter(
    (node) => node === chips || node.props.emptyState || node.props.onTextSubmit
  );
  assert.deepEqual(
    order.map((node) =>
      node === chips ? "chips" : node.props.emptyState ? "messages" : "composer"
    ),
    ["messages", "chips", "composer"]
  );
  const composer = order.at(-1);
  assert.equal(composer.props.slashCommands, slashCommands, "/ reaches the docked composer");
});

test("an action icon this build doesn't know shows a /", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-action-icons-test-" });
  const { getActionIcon } = await vite.ssrLoadModule("/components/notes/actionIcons.ts");
  const icons = await vite.ssrLoadModule("/components/icons/index.ts");

  assert.equal(getActionIcon({ icon: "rocket" }), icons.SquareSlash);
});
