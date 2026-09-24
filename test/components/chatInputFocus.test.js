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

async function mountChatInput(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
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
  root = createRoot(container);
  return { root, container, ChatInput };
}

test("closing the Notes composer cancels a pending auto-focus", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  const frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const props = {
    variant: "note",
    agentState: "idle",
    partialTranscript: "",
    onTextSubmit: () => {},
  };

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, focusOnIdle: true }))
  );
  const textarea = findNode(container, "textarea");
  assert.ok(textarea);
  let focusCount = 0;
  textarea.focus = () => focusCount++;
  const pendingFocus = frames.values().next().value;
  assert.ok(pendingFocus);

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, focusOnIdle: false }))
  );
  assert.equal(frames.size, 0, "the scheduled focus is canceled on close");
  pendingFocus();
  assert.equal(focusCount, 0, "even an in-flight frame cannot refocus a closed composer");
});

test("a composer that skips idle focus still gets focus back when a reply ends", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  const frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const props = {
    variant: "assistant",
    partialTranscript: "",
    onTextSubmit: () => {},
    focusOnIdle: false,
  };
  const render = (agentState) =>
    React.act(async () => root.render(React.createElement(ChatInput, { ...props, agentState })));

  await render("idle");
  assert.equal(frames.size, 0, "mounting idle does not grab focus");

  await render("streaming");
  await render("idle");
  const textarea = findNode(container, "textarea");
  let focusCount = 0;
  textarea.focus = () => focusCount++;
  for (const frame of frames.values()) frame();
  assert.equal(focusCount, 1, "the input is refocused after the reply");
});

test("a long Notes draft scrolls inside the compact composer after closing chat", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  const props = {
    variant: "note",
    outlined: true,
    agentState: "idle",
    partialTranscript: "",
    draftText: "A long note draft ".repeat(40),
    onTextSubmit: () => {},
    focusOnIdle: false,
  };

  await React.act(async () => root.render(React.createElement(ChatInput, props)));
  const textarea = findNode(container, "textarea");
  assert.ok(textarea);
  Object.defineProperty(textarea, "scrollHeight", { value: 240, configurable: true });

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, draftText: `${props.draftText}more` }))
  );
  assert.equal(textarea.style.height, "240px", "the open composer still sizes to its draft");

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, outlined: false }))
  );
  assert.equal(textarea.style.height, "100%", "closing chat constrains the draft to the pill");
  assert.match(textarea.parentNode.parentNode.getAttribute("class"), /h-12 overflow-hidden/);
  assert.match(textarea.getAttribute("class"), /overflow-y-auto/);
});
