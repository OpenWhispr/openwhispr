const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

function findNode(root, name) {
  if (root.localName === name) return root;
  for (const child of root.childNodes) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return null;
}

test("closing the Notes composer cancels a pending auto-focus", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-chat-focus-test-",
    mockModules: {
      "/ui/useToast": `export const useToast = () => ({ toast: () => {} });`,
      "/useVoiceDraft": `export const useVoiceDraft = () => ({ status: "idle", streamingOnlyProvider: false });`,
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });
  const { ChatInput } = await vite.ssrLoadModule("/components/chat/ChatInput.tsx");
  const props = {
    variant: "note",
    agentState: "idle",
    partialTranscript: "",
    onTextSubmit: () => {},
  };

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(ChatInput, { ...props, focusOnIdle: true })));
  const textarea = findNode(container, "textarea");
  assert.ok(textarea);
  let focusCount = 0;
  textarea.focus = () => focusCount++;
  const pendingFocus = frames.values().next().value;
  assert.ok(pendingFocus);

  await React.act(async () => root.render(React.createElement(ChatInput, { ...props, focusOnIdle: false })));
  assert.equal(frames.size, 0, "the scheduled focus is canceled on close");
  pendingFocus();
  assert.equal(focusCount, 0, "even an in-flight frame cannot refocus a closed composer");
});
