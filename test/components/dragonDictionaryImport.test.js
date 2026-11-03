const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function collect(node, result = []) {
  if (!node || typeof node !== "object") return result;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, result));
  } else if (node.props) {
    result.push(node);
    collect(node.props.children, result);
  }
  return result;
}

async function load(t, words = ["OpenWhispr"]) {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const i18n = require("i18next").createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: require("../../src/locales/en/translation.json") } },
    interpolation: { escapeValue: false },
  });
  const updates = [];
  const toasts = [];
  const state = {
    customDictionary: words,
    snippets: [],
    updateCustomDictionary: (changes) => updates.push(changes),
  };
  globalThis.__dragonDictionaryTest = { state, toasts, t: i18n.t.bind(i18n), i18n };
  t.after(() => delete globalThis.__dragonDictionaryTest);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "/hooks/useSettings":
        "export const useSettings = () => globalThis.__dragonDictionaryTest.state;",
      "/stores/settingsStore":
        "export const getSettings = () => globalThis.__dragonDictionaryTest.state;",
      "react-i18next": "export const useTranslation = () => globalThis.__dragonDictionaryTest;",
      "/ui/useToast":
        "export const useToast = () => ({ toast: value => globalThis.__dragonDictionaryTest.toasts.push(value) });",
      "/utils/agentName": 'export const getAgentName = () => "OpenWhispr";',
      "/SnippetsView": "export default function SnippetsView() { return null; }",
    },
  });
  const Dictionary = (await vite.ssrLoadModule("/components/DictionaryView.tsx")).default;
  let tree;
  function Harness() {
    tree = Dictionary();
    return null;
  }
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  const find = (predicate) => {
    const node = collect(tree).find(predicate);
    assert.ok(node, "control exists");
    return node;
  };
  const menu = (label) =>
    find((node) => node.props.onSelect && node.props.children?.includes(label));
  const dialog = () => find((node) => node.props.title === "Import from Dragon").props;
  const selectDragon = () => menu("Import from Dragon").props.onSelect();
  const pick = async (text) => {
    globalThis.window.electronAPI.dragonImportPickFile = async () => ({
      success: true,
      canceled: false,
      fileName: "vocabulary.txt",
      bytes: Buffer.from(text),
    });
    await React.act(selectDragon);
  };
  return {
    state,
    updates,
    toasts,
    render,
    find,
    menu,
    dialog,
    pick,
    selectDragon,
    description: () =>
      renderToStaticMarkup(React.createElement(React.Fragment, null, dialog().description)),
    confirm: () => React.act(async () => dialog().onConfirm()),
    close: () => React.act(async () => dialog().onOpenChange(false)),
  };
}

const almostFull = () => Array.from({ length: 4999 }, (_, index) => `existing-${index}`);

test("Dragon preview follows dictionary changes while the native picker is open", async (t) => {
  const ui = await load(t, almostFull());
  let resolvePicker;
  globalThis.window.electronAPI.dragonImportPickFile = () =>
    new Promise((resolve) => {
      resolvePicker = resolve;
    });
  let pending;
  await React.act(async () => {
    pending = ui.selectDragon();
  });
  ui.state.customDictionary = [...ui.state.customDictionary, "from-sync"];
  await ui.render();
  await React.act(async () => {
    resolvePicker({
      success: true,
      canceled: false,
      fileName: "words.txt",
      bytes: Buffer.from("alpha\nbeta"),
    });
    await pending;
  });
  assert.equal(ui.dialog().confirmDisabled, true);
  assert.equal(ui.dialog().confirmText, "Import 0 words");
  await ui.confirm();
  assert.deepEqual(ui.updates, []);
  assert.deepEqual(ui.toasts, []);
});

test("Dragon preview replans capacity and duplicates until confirmation", async (t) => {
  const ui = await load(t, almostFull());
  await ui.pick("alpha\nbeta");
  assert.equal(ui.dialog().confirmText, "Import 1 word");
  ui.state.customDictionary = [...ui.state.customDictionary, "alpha"];
  await ui.render();
  assert.equal(ui.dialog().confirmDisabled, true);
  assert.match(ui.description(), /not imported: 1/);
  ui.state.customDictionary = ui.state.customDictionary.slice(2);
  await ui.render();
  assert.equal(ui.dialog().confirmText, "Import 1 word");
  await ui.confirm();
  assert.deepEqual(ui.updates, [{ add: ["beta"] }]);
  assert.equal(ui.toasts[0].title, "Imported 1 word from Dragon");
});

test("confirmation checks current store state even before React renders its update", async (t) => {
  const ui = await load(t, almostFull());
  await ui.pick("alpha\nbeta");
  ui.state.customDictionary = [...ui.state.customDictionary, "from-sync"];
  await ui.confirm();
  assert.deepEqual(ui.updates, []);
  assert.deepEqual(ui.toasts, []);
});

test("Dragon import preserves preview, cancellation, dedupe, warnings and retry behavior", async (t) => {
  const ui = await load(t);
  await ui.pick("OpenWhispr\nalpha\nALPHA\nbeta\\\\spoken\n" + "x".repeat(101));
  assert.equal(ui.dialog().confirmText, "Import 2 words");
  assert.match(ui.description(), /Words over 100 characters/);
  await ui.close();
  assert.deepEqual(ui.updates, []);
  await ui.pick("alpha\nbeta");
  await ui.confirm();
  assert.deepEqual(ui.updates, [{ add: ["alpha", "beta"] }]);
  assert.equal(ui.toasts.pop().title, "Imported 2 words from Dragon");
  await ui.close();
  ui.state.customDictionary = ["OpenWhispr", "alpha", "beta"];
  await ui.render();
  await ui.pick("alpha\nbeta");
  assert.equal(ui.dialog().confirmDisabled, true);
  assert.match(ui.description(), /Every word in this file/);
  await ui.close();
  for (const result of [
    { canceled: true },
    { canceled: false, success: false, error: "FILE_TOO_LARGE" },
  ]) {
    globalThis.window.electronAPI.dragonImportPickFile = async () => result;
    await React.act(ui.selectDragon);
    assert.equal(ui.dialog().open, false);
  }
  assert.equal(ui.toasts.pop().variant, "destructive");
  await ui.pick('<WordExport><Word name="gamma"><Property/></Word></WordExport>');
  assert.match(ui.description(), /formatting properties are not imported/);
  await ui.confirm();
  assert.deepEqual(ui.updates.at(-1), { add: ["gamma"] });
});

test("the add row retains Enter, manual list import, editing, removal and export", async (t) => {
  const ui = await load(t, ["OpenWhispr", "existing"]);
  // Locate the add field by its keyboard behavior so translated placeholders are irrelevant.
  const addInput = () => ui.find((node) => node.props.onKeyDown && !node.props.onBlur).props;
  await React.act(async () => addInput().onChange({ target: { value: "new word" } }));
  await React.act(async () => addInput().onKeyDown({ key: "Enter" }));
  assert.deepEqual(ui.updates.pop(), { add: ["new word"] });
  await React.act(async () => ui.menu("Import a list").props.onSelect());
  await React.act(async () =>
    ui
      .find((node) => node.props.rows)
      .props.onChange({ target: { value: "first, second\nexisting" } })
  );
  await React.act(async () =>
    ui.find((node) => node.props.children === "Import" && node.props.onClick).props.onClick()
  );
  assert.deepEqual(ui.updates.pop(), { add: ["first", "second"] });
  await React.act(async () =>
    ui.find((node) => node.props["aria-label"] === "Edit existing").props.onClick()
  );
  await React.act(async () =>
    ui.find((node) => node.props.onBlur).props.onChange({ target: { value: "edited" } })
  );
  await React.act(async () =>
    ui.find((node) => node.props.onBlur).props.onKeyDown({ key: "Enter" })
  );
  assert.deepEqual(ui.updates.pop(), { add: ["edited"], remove: ["existing"] });
  await React.act(async () =>
    ui.find((node) => node.props["aria-label"] === "Remove existing").props.onClick()
  );
  assert.deepEqual(ui.updates.pop(), { remove: ["existing"] });
  let exported;
  globalThis.window.electronAPI.exportDictionary = async (words) => {
    exported = words;
    return { success: true };
  };
  await React.act(async () =>
    ui.find((node) => node.props["aria-label"] === "Export dictionary").props.onClick()
  );
  assert.deepEqual(exported, ["OpenWhispr", "existing"]);
});

test("confirmation reports only additions that still fit before the next render", async (t) => {
  const ui = await load(t, almostFull().slice(1));
  await ui.pick("alpha\nbeta");
  assert.equal(ui.dialog().confirmText, "Import 2 words");
  ui.state.customDictionary = [...ui.state.customDictionary, "from-sync"];
  await ui.confirm();
  assert.deepEqual(ui.updates, [{ add: ["alpha"] }]);
  assert.equal(ui.toasts[0].title, "Imported 1 word from Dragon");
});
