const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

async function setup(t, focused = true) {
  const toasts = [],
    dismissed = [],
    calls = [],
    pushes = [];
  const listeners = new Map();
  // Main's claim: each recovery is offered by one window, once.
  const claimed = new Set();
  let edits = [],
    result = { success: true },
    root;
  const emit = async (event) => React.act(async () => listeners.get(event)?.());
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__assistantUndoToast;
  });
  installBrowserGlobals(t, {
    window: {
      addEventListener: (event, cb) => listeners.set(event, cb),
      removeEventListener: (event) => listeners.delete(event),
      electronAPI: {
        getNoteUndos: async () => edits,
        claimNoteUndo: async (token) => !claimed.has(token) && !!claimed.add(token),
        undoNoteUpdate: async (token) => {
          calls.push(token);
          if (result instanceof Error) throw result;
          return result;
        },
        discardNoteUndo: async (...args) => calls.push(args),
        onNoteUpdated: (cb) => {
          listeners.set("note", cb);
          return () => listeners.delete("note");
        },
        onActiveAccountScopeChanged: (cb) => {
          listeners.set("scope", cb);
          return () => listeners.delete("scope");
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.document.hasFocus = () => focused;
  globalThis.__assistantUndoToast = {
    pushes,
    toast: (props) => {
      toasts.push(props);
      return `toast-${toasts.length}`;
    },
    dismiss: (id) => dismissed.push(id),
  };
  const vite = await createRendererServer(t, {
    mockModules: {
      "/services/SyncService": `export const syncService = { debouncedPush: (...args) => globalThis.__assistantUndoToast.pushes.push(args) };`,
      "/ui/useToast": "export const useToast = () => globalThis.__assistantUndoToast;",
      "/ui/Toast": `import { createElement } from "react"; export const ToastActionButton = ({ onClick, children }) => createElement("button", { onClick }, children);`,
    },
  });
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/notes/AssistantNoteUndoListener.tsx"
  );
  const mount = async () => {
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Listener)));
  };
  await mount();
  return {
    toasts,
    dismissed,
    calls,
    pushes,
    claimed,
    emit,
    setResult: (value) => {
      result = value;
    },
    setEdits: (value) => {
      edits = value;
    },
    focus: async () => {
      focused = true;
      await emit("focus");
    },
    blur: () => {
      focused = false;
    },
    remount: async () => {
      await React.act(async () => root.unmount());
      await mount();
    },
  };
}
const one = { noteId: 7, token: "first", title: "First note" };

test("a background window offers Undo once focused; it targets the edited note", async (t) => {
  const state = await setup(t, false);
  state.setEdits([one]);
  await state.emit("note");
  assert.equal(state.toasts.length, 0);
  await state.focus();
  assert.equal(state.toasts.length, 1);
  assert.match(state.toasts[0].title, /First note/);
  assert.equal(state.toasts[0].duration, 6000);
  await state.emit("focus");
  assert.equal(state.toasts.length, 1);
  await React.act(async () => state.toasts[0].action.props.onClick());
  assert.deepEqual(state.calls, ["first"]);
  assert.deepEqual(state.pushes, [["note", 7]]);
  assert.ok(state.dismissed.includes("toast-1"));
});

test("an edit offered elsewhere or before a reload is not offered again", async (t) => {
  const state = await setup(t);
  state.claimed.add("other-window");
  state.setEdits([{ ...one, token: "other-window" }]);
  await state.emit("note");
  assert.equal(state.toasts.length, 0, "another window already offered it");
  state.setEdits([one]);
  await state.emit("note");
  assert.equal(state.toasts.length, 1);
  await state.remount();
  assert.equal(state.toasts.length, 1, "a reload does not offer it again");
});

test("an unfocused window drops its toast once the recovery is gone", async (t) => {
  const state = await setup(t);
  state.setEdits([one]);
  await state.emit("note");
  state.blur();
  state.setEdits([]);
  await state.emit("note");
  assert.ok(state.dismissed.includes("toast-1"), "undone in the other window");
  assert.equal(state.toasts.length, 1);
});

test("a later edit replaces the old toast and unavailable Undo explains the refusal", async (t) => {
  const state = await setup(t);
  state.setEdits([one]);
  await state.emit("note");
  state.setEdits([{ ...one, token: "second" }]);
  await state.emit("note");
  assert.ok(state.dismissed.includes("toast-1"));
  state.setResult({ success: false, error: "note_changed" });
  await React.act(async () => state.toasts[1].action.props.onClick());
  assert.deepEqual(state.calls, ["second"]);
  assert.match(state.toasts[2].description, /changed.*Undo/);
  assert.ok(state.dismissed.includes("toast-2"), "a refused Undo cannot be clicked again");
  assert.deepEqual(state.pushes, []);
});

test("a failed restore keeps the toast; closing it retires only its recovery", async (t) => {
  const state = await setup(t);
  state.setEdits([{ ...one, title: "" }]);
  await state.emit("note");
  assert.match(state.toasts[0].title, /Untitled/);
  state.setResult({ success: false, error: "disk full" });
  await React.act(async () => state.toasts[0].action.props.onClick());
  assert.match(state.toasts[1].description, /Could not undo/);
  assert.equal(state.dismissed.includes("toast-1"), false);
  await React.act(async () => state.toasts[0].onClose());
  assert.deepEqual(state.calls.at(-1), [7, "first"]);
});

test("Undo errors stay visible and double clicks cannot issue parallel restores", async (t) => {
  const state = await setup(t);
  state.setEdits([one]);
  await state.emit("note");
  state.setResult(new Error("disk full"));
  await React.act(async () =>
    Promise.all([state.toasts[0].action.props.onClick(), state.toasts[0].action.props.onClick()])
  );
  assert.deepEqual(state.calls, ["first"]);
  assert.match(state.toasts[1].description, /Could not undo/);
  assert.deepEqual(state.pushes, []);
});

test("scope changes dismiss old note names and ignore an outstanding list response", async (t) => {
  const state = await setup(t);
  state.setEdits([one]);
  await state.emit("note");
  let release;
  const original = globalThis.window.electronAPI.getNoteUndos;
  globalThis.window.electronAPI.getNoteUndos = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const old = state.emit("note");
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.window.electronAPI.getNoteUndos = original;
  state.setEdits([]);
  await state.emit("scope");
  release([{ ...one, token: "stale" }]);
  await old;
  assert.equal(state.toasts.length, 1);
  assert.ok(state.dismissed.includes("toast-1"));
});
