const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

async function mountListener(t, updateNoteResult) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__toasts;
    delete globalThis.__dismissed;
  });
  const writes = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateNote: async (noteId, payload) => {
          writes.push({ noteId, payload });
          return updateNoteResult;
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__toasts = [];
  globalThis.__dismissed = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-toast-listener-test-",
    mockModules: {
      "/ui/useToast": `
        export const useToast = () => ({
          toast: (props) => { globalThis.__toasts.push(props); return "toast-" + globalThis.__toasts.length; },
          dismiss: (id) => globalThis.__dismissed.push(id),
        });
      `,
      "/services/ReasoningService": `export default { processText: async () => "" };`,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
      "/ui/Toast": `
        import { createElement } from "react";
        export const ToastActionButton = ({ onClick, children }) => createElement("button", { onClick }, children);
      `,
    },
  });
  const { default: Listener } = await vite.ssrLoadModule(
    "/components/notes/BackgroundActionToastListener.tsx"
  );
  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Listener)));
  return { store, writes };
}

const PREVIOUS = {
  enhanced_content: null,
  enhancement_prompt: null,
  enhancement_template_id: null,
  enhanced_at_content_hash: null,
};
const APPLIED = {
  noteId: 4,
  action: { id: 1, name: "Shorten", translation_key: null },
  previous: PREVIOUS,
};

test("a note run offers Undo, which writes back what the run replaced", async (t) => {
  const { store, writes } = await mountListener(t, { success: true });
  await React.act(async () =>
    store.useActionProcessingStore.setState({ appliedEvents: [APPLIED] })
  );

  assert.equal(globalThis.__toasts.length, 1);
  const [toast] = globalThis.__toasts;
  assert.ok(toast.duration >= 5000 && toast.duration <= 6000, "a short undo window");
  assert.deepEqual(store.useActionProcessingStore.getState().appliedEvents, [], "consumed once");

  await React.act(async () => toast.action.props.onClick());
  assert.deepEqual(writes, [{ noteId: 4, payload: PREVIOUS }]);
  assert.deepEqual(globalThis.__dismissed, ["toast-1"]);
});

test("an undo the database refused leaves the toast up to try again", async (t) => {
  const { store, writes } = await mountListener(t, { success: false });
  await React.act(async () =>
    store.useActionProcessingStore.setState({ appliedEvents: [APPLIED] })
  );

  await React.act(async () => globalThis.__toasts[0].action.props.onClick());
  assert.equal(writes.length, 1);
  assert.deepEqual(globalThis.__dismissed, []);
});
