const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function findNode(root, name) {
  if (root.localName === name) return root;
  for (const child of root.childNodes) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return null;
}

async function mountChatInput(t, installDom = installHostDom) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installDom(t);
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
  const pendingFocus = frames.values().next().value;
  assert.ok(pendingFocus);

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, focusOnIdle: false }))
  );
  assert.equal(frames.size, 0, "the scheduled focus is canceled on close");
});

test("a streaming reply keeps the composer focusable", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t);
  await React.act(async () =>
    root.render(
      React.createElement(ChatInput, {
        variant: "assistant",
        agentState: "streaming",
        partialTranscript: "",
        draftText: "follow-up",
        onTextSubmit: () => {},
        focusOnIdle: false,
      })
    )
  );
  const textarea = findNode(container, "textarea");
  assert.equal(textarea.hasAttribute("disabled"), false, "a disabled field would drop focus");
  assert.equal(textarea.hasAttribute("readOnly"), true);
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
});

test("a host that cannot send yet keeps the draft by writing it back", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t, installInteractiveDom);
  const drafts = [];
  const onDraftChange = (text) => drafts.push(text);
  await React.act(async () =>
    root.render(
      React.createElement(ChatInput, {
        variant: "note",
        agentState: "idle",
        partialTranscript: "",
        draftText: "Next question",
        onDraftChange,
        // Like the Notes composer while its chat is still replying.
        onTextSubmit: onDraftChange,
        focusOnIdle: false,
      })
    )
  );
  const send = findElement(
    container,
    (element) => element.getAttribute?.("aria-label") === "agentMode.input.send"
  );
  await React.act(async () =>
    send.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} })
  );
  assert.equal(drafts.at(-1), "Next question");
});

test("the assistant send button reads as active only once there is a draft", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t, installInteractiveDom);
  const props = {
    variant: "assistant",
    agentState: "idle",
    partialTranscript: "",
    onTextSubmit: () => {},
    focusOnIdle: false,
  };
  const sendCircleClass = () => {
    const send = findElement(
      container,
      (element) => element.getAttribute?.("aria-label") === "agentMode.input.send"
    );
    return send.childNodes[0].getAttribute("class");
  };

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, draftText: "" }))
  );
  assert.match(sendCircleClass(), /bg-muted/, "an empty draft leaves the send button muted");

  await React.act(async () =>
    root.render(React.createElement(ChatInput, { ...props, draftText: "Summarize my week" }))
  );
  assert.doesNotMatch(sendCircleClass(), /bg-muted/);
  assert.match(sendCircleClass(), /gradient-brand-glass/, "a draft lights up the send button");
});

test("cancelling a reply hands focus back to the composer", async (t) => {
  const { root, container, ChatInput } = await mountChatInput(t, installInteractiveDom);
  let cancelled = 0;
  await React.act(async () =>
    root.render(
      React.createElement(ChatInput, {
        variant: "assistant",
        agentState: "streaming",
        partialTranscript: "",
        onTextSubmit: () => {},
        onCancel: () => cancelled++,
        // Like the Assistant page, which never refocuses on idle by itself.
        focusOnIdle: false,
      })
    )
  );
  const cancel = findElement(
    container,
    (element) => element.getAttribute?.("aria-label") === "common.cancel"
  );
  cancel.focus();
  await React.act(async () =>
    cancel.dispatchEvent({ type: "click", bubbles: true, button: 0, preventDefault() {} })
  );
  assert.equal(cancelled, 1);
  assert.equal(
    cancel.ownerDocument.activeElement?.tagName === "TEXTAREA",
    true,
    "focus would otherwise fall to the page when the Cancel button unmounts"
  );
});
