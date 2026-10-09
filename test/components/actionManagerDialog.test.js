const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { BUILTIN_ACTIONS } = require("../../src/helpers/builtinActions.js");

function collect(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (Array.isArray(node)) {
    node.forEach((n) => collect(n, result));
    return result;
  }
  if (node.props) {
    result.push(node);
    collect(node.props.children, result);
  }
  return result;
}

async function load(t, rows = [], initialKind = "action") {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  const saves = [];
  const toasts = [];
  let failure = false;
  let throws = false;
  const persist = (...args) => {
    saves.push(args);
    if (throws) throw new Error("IPC failed");
    return { success: !failure };
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getActions: async () => rows,
        createAction: async (...args) => persist("create", ...args),
        updateAction: async (...args) => persist("update", ...args),
      },
    },
  });
  const container = installHookDom(t);
  globalThis.__actionDialogToasts = toasts;
  t.after(() => delete globalThis.__actionDialogToasts);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-manager-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key) => key; export function useTranslation() { return { t }; }`,
      "/ui/useToast": `export function useToast() { return { toast: (value) => globalThis.__actionDialogToasts.push(value) }; }`,
    },
  });
  const Dialog = (await vite.ssrLoadModule("/components/notes/ActionManagerDialog.tsx")).default;
  let tree;
  function Harness() {
    tree = Dialog({ open: true, onOpenChange() {}, initialKind });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const elements = () => collect(tree);
  const find = (predicate) => {
    const node = elements().find(predicate);
    assert.ok(node, "control exists");
    return node;
  };
  const click = (label) =>
    React.act(async () =>
      find(
        (n) =>
          n.props.onClick &&
          (n.props.children === label ||
            (Array.isArray(n.props.children) && n.props.children.includes(label)) ||
            n.props["aria-label"] === label)
      ).props.onClick()
    );
  const change = (placeholder, value) =>
    React.act(async () =>
      find((n) => n.props.placeholder === placeholder).props.onChange({ target: { value } })
    );
  return {
    saves,
    toasts,
    elements,
    find,
    click,
    change,
    fail: (value) => {
      failure = value;
    },
    throwOnSave: () => {
      throws = true;
    },
  };
}

const row = (key) => {
  const b = BUILTIN_ACTIONS.find((a) => a.translationKey.endsWith(`.${key}`));
  return {
    ...b,
    id: 10,
    client_id: b.translationKey,
    translation_key: b.translationKey,
    is_builtin: 1,
  };
};

test("creating a custom action has a fixed chat hint, no destination selector and one persistence call", async (t) => {
  const ui = await load(t);
  await ui.click("notes.actions.addAction");
  assert.deepEqual(
    ui.elements().filter((n) => ["auto", "chat", "summary"].includes(n.props.value)),
    []
  );
  assert.ok(ui.elements().some((n) => n.props.children === "notes.actions.output.chatHint"));
  assert.equal(ui.find((n) => n.props.children === "notes.actions.save").props.disabled, true);
  await ui.change("notes.actions.namePlaceholder", "Make notes shorter");
  await ui.change("notes.actions.promptPlaceholder", "Replace the summary with a poem");
  await ui.click("notes.actions.save");
  assert.equal(ui.saves.length, 1);
  assert.deepEqual(ui.saves[0], [
    "create",
    "Make notes shorter",
    "",
    "Replace the summary with a poem",
    undefined,
    { kind: "action" },
  ]);
});

test("failed and rejected saves keep the draft editable and show the save error", async (t) => {
  const ui = await load(t);
  await ui.click("notes.actions.addAction");
  await ui.change("notes.actions.namePlaceholder", "Custom");
  await ui.change("notes.actions.promptPlaceholder", "Draft a reply");
  ui.fail(true);
  await ui.click("notes.actions.save");
  assert.equal(ui.toasts.length, 1);
  assert.equal(
    ui.find((n) => n.props.placeholder === "notes.actions.promptPlaceholder").props.value,
    "Draft a reply"
  );
  ui.throwOnSave();
  await ui.click("notes.actions.save");
  assert.equal(ui.toasts.length, 2);
  assert.equal(ui.find((n) => n.props.children === "notes.actions.save").props.disabled, false);
});

test("template section editing, ordering and saving stay separate from action destinations", async (t) => {
  const template = {
    ...row("oneOnOne"),
    sections: [
      { heading: "First", instruction: "Keep facts" },
      { heading: "Second", instruction: "Next steps" },
    ],
  };
  const ui = await load(t, [template], "template");
  const sections = ui
    .elements()
    .filter((n) => n.props["aria-label"] === "notes.templates.moveSectionDown");
  await React.act(async () => sections[0].props.onClick());
  await ui.change("notes.templates.sectionInstructionPlaceholder", "Edited next steps");
  await ui.click("notes.actions.update");
  assert.deepEqual(ui.saves[0][2].sections, [
    { heading: "Second", instruction: "Edited next steps" },
    { heading: "First", instruction: "Keep facts" },
  ]);
  assert.equal(ui.saves[0][2].output, undefined);
  await ui.click("notes.templates.addTemplate");
  await ui.change("notes.templates.namePlaceholder", "New template");
  await ui.click("notes.templates.addSection");
  await ui.change("notes.templates.sectionInstructionPlaceholder", "Cannot save without a heading");
  assert.equal(ui.find((n) => n.props.children === "notes.actions.save").props.disabled, true);
  await ui.change("notes.templates.sectionHeadingPlaceholder", "## Decisions");
  await ui.click("notes.actions.save");
  assert.deepEqual(ui.saves[1].at(-1), {
    kind: "template",
    sections: [{ heading: "Decisions", instruction: "Cannot save without a heading" }],
  });
});
