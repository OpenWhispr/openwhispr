const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

function installInteractiveDom(t) {
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  const originalElement = globalThis.Element;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalHTMLIFrameElement = globalThis.HTMLIFrameElement;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  class FakeNode {
    constructor(nodeType, nodeName, ownerDocument) {
      this.nodeType = nodeType;
      this.nodeName = nodeName;
      this.ownerDocument = ownerDocument;
      this.parentNode = null;
      this.childNodes = [];
    }

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
      this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
      child.parentNode = this;
      return child;
    }

    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    }

    contains(candidate) {
      for (let current = candidate; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    }

    get firstChild() {
      return this.childNodes[0] ?? null;
    }

    get lastChild() {
      return this.childNodes.at(-1) ?? null;
    }

    get nextSibling() {
      if (!this.parentNode) return null;
      const index = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[index + 1] ?? null;
    }

    get textContent() {
      return this.childNodes.map((child) => child.textContent).join("");
    }

    set textContent(value) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      if (value !== "") this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
  }

  class Element extends FakeNode {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  class FakeText extends FakeNode {
    constructor(value, ownerDocument) {
      super(3, "#text", ownerDocument);
      this.nodeValue = value;
    }

    get textContent() {
      return this.nodeValue;
    }

    set textContent(value) {
      this.nodeValue = String(value);
    }
  }

  class FakeElement extends HTMLElement {
    constructor(tagName, ownerDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
      super(1, tagName.toUpperCase(), ownerDocument);
      this.tagName = tagName.toUpperCase();
      this.namespaceURI = namespaceURI;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {
        setProperty: (name, value) => {
          this.style[name] = value;
        },
        removeProperty: (name) => {
          delete this.style[name];
        },
      };
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
      if (!event.target) event.target = this;
      for (let current = this; current; current = event.bubbles ? current.parentNode : null) {
        event.currentTarget = current;
        for (const listener of current.listeners?.get(event.type) ?? []) listener(event);
        if (event.cancelBubble) break;
      }
      return !event.defaultPrevented;
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }
  }

  const documentListeners = new Map();
  const document = {
    nodeType: 9,
    nodeName: "#document",
    activeElement: null,
    createElement: (tagName) => new FakeElement(tagName, document),
    createElementNS: (namespaceURI, tagName) => new FakeElement(tagName, document, namespaceURI),
    createTextNode: (value) => new FakeText(String(value), document),
    createComment: (value) => {
      const comment = new FakeNode(8, "#comment", document);
      comment.nodeValue = String(value);
      return comment;
    },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    },
  };
  const container = new FakeElement("div", document);
  document.documentElement = container;
  document.body = container;
  document.defaultView = globalThis.window;
  Object.assign(globalThis.window, {
    Node: FakeNode,
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => ({
      isCollapsed: true,
      rangeCount: 0,
      removeAllRanges() {},
    }),
  });
  globalThis.document = document;
  globalThis.Node = FakeNode;
  globalThis.Element = Element;
  globalThis.HTMLElement = HTMLElement;
  globalThis.HTMLIFrameElement = HTMLIFrameElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalNode === undefined) delete globalThis.Node;
    else globalThis.Node = originalNode;
    if (originalElement === undefined) delete globalThis.Element;
    else globalThis.Element = originalElement;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalHTMLIFrameElement === undefined) delete globalThis.HTMLIFrameElement;
    else globalThis.HTMLIFrameElement = originalHTMLIFrameElement;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

function findElement(root, predicate) {
  if (root.nodeType === 1 && predicate(root)) return root;
  for (const child of root.childNodes) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return null;
}

async function renderAssistantPanel(
  t,
  messages,
  { initialConversationId = null, agentState = "idle", activeToolName = null, locale = "en" } = {}
) {
  installBrowserGlobals(t);
  globalThis.__assistantPanelMessages = messages;
  globalThis.__assistantPanelAgentState = agentState;
  globalThis.__assistantPanelActiveToolName = activeToolName;
  t.after(() => {
    delete globalThis.__assistantPanelMessages;
    delete globalThis.__assistantPanelAgentState;
    delete globalThis.__assistantPanelActiveToolName;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-test-",
    mockModules: {
      "/chat/useChatPersistence": `
        export function useChatPersistence() {
          return {
            messages: globalThis.__assistantPanelMessages,
            setMessages() {},
            conversationId: null,
            async createConversation() { return 1; },
            async loadConversation() {},
            saveUserMessage() {},
            saveAssistantMessage() {},
            handleNewChat() {},
          };
        }
      `,
      "/chat/useChatStreaming": `
        export function useChatStreaming() {
          return {
            agentState: globalThis.__assistantPanelAgentState,
            activeToolName: globalThis.__assistantPanelActiveToolName,
            toolStatus: "",
            cancelStream() {},
          };
        }
      `,
      "/chat/useChatMessageSender": `
        export function useChatMessageSender() { return () => {}; }
      `,
      useVoiceDraft: `
        export function useVoiceDraft() {
          return { status: "idle", elapsed: 0, readLevel: () => 0, start() {}, stop() {}, cancel() {} };
        }
      `,
      "/hooks/useWindowDrag": `
        export function useWindowDrag() { return { handleMouseDown() {}, handleMouseUp() {} }; }
      `,
      "/hooks/useCopyFeedback": `
        export function useCopyFeedback() {
          return { copied: false, async copy() {}, confirmCopied() {} };
        }
      `,
      "/stores/settingsStore": `
        const state = { voiceAgentKey: [] };
        export function useSettingsStore(selector) { return selector(state); }
      `,
      "/utils/hotkeys": `
        export function formatHotkeyListLabel() { return ""; }
      `,
      "/ui/MarkdownRenderer": `
        import React from "react";
        export function MarkdownRenderer({ content, className }) {
          return React.createElement("div", { className }, content);
        }
      `,
      "/ui/useToast": `
        export function useToast() { return { toast() {} }; }
      `,
    },
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../../src/locales/${locale}/translation.json`), "utf8")
  );
  await viteI18next.use(initReactI18next).init({
    lng: locale,
    resources: { [locale]: { translation } },
    interpolation: { escapeValue: false },
  });
  const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
  return renderToStaticMarkup(
    React.createElement(AssistantPanel, {
      pendingCommand: null,
      onCommandConsumed: noop,
      onCommandDiscarded: noop,
      initialConversationId,
      onConversationIdChange: noop,
      voiceState: "idle",
      thinking: false,
      open: true,
      footerPhase: "pill",
      horizontalDirection: "right",
      onClose: noop,
      onBusyChange: noop,
      onResponseReadyChange: noop,
      onResponseContent: noop,
      onConversationReset: noop,
      onSelectionContextChange: noop,
    })
  );
}

test("an empty idle Assistant shows typed input and generic suggestions", async (t) => {
  const markup = await renderAssistantPanel(t, []);

  assert.match(markup, /<input/);
  assert.match(markup, /Summarize my recent notes/);
  assert.match(markup, /What is on my calendar\?/);
  assert.match(markup, /Help me draft something/);
});

test("a populated Assistant keeps typed input without empty-state suggestions", async (t) => {
  const markup = await renderAssistantPanel(t, [
    { id: "assistant-1", role: "assistant", content: "Existing answer", isStreaming: false },
  ]);

  assert.match(markup, /Existing answer/);
  assert.match(markup, /<input/);
  assert.doesNotMatch(markup, /Summarize my recent notes/);
});

test("starting a new conversation clears the displayed response and parent content ownership", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const lifecycleEvents = [];
  globalThis.__assistantPanelLifecycleEvents = lifecycleEvents;
  t.after(() => {
    delete globalThis.__assistantPanelLifecycleEvents;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-reset-test-",
    mockModules: {
      "lucide-react": `
        import React from "react";
        const Icon = () => React.createElement("span");
        export const Check = Icon;
        export const Copy = Icon;
        export const Plus = Icon;
        export const X = Icon;
      `,
      "/chat/useChatPersistence": `
        import { useCallback, useState } from "react";
        const initialMessages = [
          { id: "assistant-1", role: "assistant", content: "Prior rendered response", isStreaming: false },
        ];
        export function useChatPersistence() {
          const [messages, setMessages] = useState(initialMessages);
          const [conversationId, setConversationId] = useState(42);
          const handleNewChat = useCallback(() => {
            globalThis.__assistantPanelLifecycleEvents.push("persistence-reset");
            setMessages([]);
            setConversationId(null);
          }, []);
          return {
            messages,
            setMessages,
            conversationId,
            async createConversation() { return 1; },
            async loadConversation() {},
            saveUserMessage() {},
            saveAssistantMessage() {},
            handleNewChat,
          };
        }
      `,
      "/chat/useChatStreaming": `
        import { useEffect } from "react";
        export function useChatStreaming({ onResponseContent }) {
          useEffect(() => onResponseContent(), [onResponseContent]);
          return {
            agentState: "idle",
            activeToolName: null,
            toolStatus: "",
            cancelStream() {},
          };
        }
      `,
      "/chat/useChatMessageSender": `
        export function useChatMessageSender() { return async () => true; }
      `,
      "/chat/ChatInput": `
        import React from "react";
        export function ChatInput() { return React.createElement("input"); }
      `,
      "/dictation/AssistantEmptyState": `
        import React from "react";
        export function AssistantEmptyState() { return React.createElement("div", null, "Empty state"); }
      `,
      "/dictation/BrandMarkIcon": `
        import React from "react";
        export function BrandMarkIcon() { return React.createElement("span"); }
      `,
      "/ui/MarkdownRenderer": `
        import React from "react";
        export function MarkdownRenderer({ content }) { return React.createElement("div", null, content); }
      `,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "/hooks/useWindowDrag": `
        export function useWindowDrag() { return { handleMouseDown() {}, handleMouseUp() {} }; }
      `,
      "/hooks/useCopyFeedback": `
        export function useCopyFeedback() {
          return { copied: false, async copy() {}, confirmCopied() {} };
        }
      `,
      "/stores/settingsStore": `
        const state = { voiceAgentKey: [] };
        export function useSettingsStore(selector) { return selector(state); }
      `,
      "/utils/hotkeys": `
        export function formatHotkeyListLabel() { return ""; }
      `,
      "/ui/useToast": `
        export function useToast() { return { toast() {} }; }
      `,
    },
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await viteI18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation } },
    interpolation: { escapeValue: false },
  });
  const [{ AssistantPanel }, { useAssistantPanel }] = await Promise.all([
    vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx"),
    vite.ssrLoadModule("/hooks/useAssistantPanel.js"),
  ]);
  const { createRoot } = require("react-dom/client");
  let dictationErrorActionCount = 0;
  let assistant;
  const requestMainWindowSize = async () => ({ success: true });
  const recordingControlsRef = { current: null };

  function Harness() {
    assistant = useAssistantPanel({
      requestMainWindowSize,
      dictationErrorActionCount,
      recordingControlsRef,
    });
    return React.createElement(AssistantPanel, {
      pendingCommand: null,
      onCommandConsumed: noop,
      onCommandDiscarded: noop,
      onCommandSettled: noop,
      initialConversationId: 42,
      onConversationIdChange: (conversationId) => {
        lifecycleEvents.push(`conversation:${conversationId}`);
        assistant.setConversationId(conversationId);
      },
      voiceState: "idle",
      thinking: false,
      open: true,
      footerPhase: "pill",
      horizontalDirection: "right",
      onClose: noop,
      onBusyChange: assistant.setBusy,
      onResponseReadyChange: assistant.setResponseReady,
      onResponseContent: assistant.handleResponseContent,
      onConversationReset: () => {
        lifecycleEvents.push("content-reset");
        assistant.handleConversationReset();
      },
      onSelectionContextChange: (context) => lifecycleEvents.push(`selection:${context}`),
    });
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.match(container.textContent, /Prior rendered response/);
  assert.equal(assistant.openRef.current, true);

  lifecycleEvents.length = 0;
  const newConversationButton = findElement(
    container,
    (element) => element.getAttribute("aria-label") === "New conversation"
  );
  assert.ok(newConversationButton, "fixture setup: populated Assistant exposes reset control");
  await React.act(async () => {
    newConversationButton.dispatchEvent({
      type: "click",
      bubbles: true,
      button: 0,
      defaultPrevented: false,
      cancelBubble: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.cancelBubble = true;
      },
    });
  });

  assert.doesNotMatch(container.textContent, /Prior rendered response/);
  assert.deepEqual(lifecycleEvents.slice(0, 4), [
    "persistence-reset",
    "conversation:null",
    "selection:null",
    "content-reset",
  ]);

  await React.act(async () => assistant.noteDictationError({ recoverAssistant: true }));
  dictationErrorActionCount = 1;
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(assistant.closing, true);
  await React.act(async () => assistant.completeContentFade());
  assert.equal(assistant.openRef.current, false);
});

test("the Assistant exposes an accessible new-conversation control only after messages exist", async (t) => {
  const populatedMarkup = await renderAssistantPanel(t, [
    { id: "assistant-1", role: "assistant", content: "Existing answer", isStreaming: false },
  ]);
  const emptyMarkup = await renderAssistantPanel(t, []);

  assert.match(populatedMarkup, /<button[^>]*aria-label="New conversation"/);
  assert.doesNotMatch(emptyMarkup, /<button[^>]*aria-label="New conversation"/);
});

test("a reopened Assistant blocks typed actions until retained history finishes loading", async (t) => {
  const markup = await renderAssistantPanel(t, [], { initialConversationId: 42 });

  assert.match(markup, /<input[^>]*disabled=""/);
  assert.doesNotMatch(markup, /Summarize my recent notes/);
});

test("the Assistant response cancel control has an accessible name", async (t) => {
  const markup = await renderAssistantPanel(t, [], { agentState: "streaming" });

  assert.match(markup, /<button[^>]*aria-label="Cancel"[^>]*title="Cancel"/);
});

test("the Assistant localizes the active registered tool name", async (t) => {
  const markup = await renderAssistantPanel(t, [], {
    activeToolName: "search_notes",
    locale: "es",
  });

  assert.match(markup, />Buscar notas</);
  assert.doesNotMatch(markup, />Search notes</);
});

test("the Assistant uses its localized fallback for an unknown active tool", async (t) => {
  const markup = await renderAssistantPanel(t, [], {
    activeToolName: "unregistered_tool",
    locale: "es",
  });

  assert.match(markup, />Herramienta</);
  assert.doesNotMatch(markup, />Unregistered tool</);
});

test("an automatic clipboard delivery keeps the shared Copy button confirmed for six seconds", async (t) => {
  let root = null;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    globalThis.setTimeout = originalSetTimeout;
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const scheduledDelays = [];
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-copy-feedback-test-",
  });
  const { useCopyFeedback } = await vite.ssrLoadModule("/hooks/useCopyFeedback.ts");
  const { createRoot } = require("react-dom/client");
  let copyFeedback;

  function Harness() {
    copyFeedback = useCopyFeedback("Agent answer");
    return React.createElement("button", null, copyFeedback.copied ? "Copied" : "Copy");
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  globalThis.setTimeout = (callback, delay, ...args) => {
    scheduledDelays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  await React.act(async () => copyFeedback.confirmCopied("Agent answer", 6000));

  assert.equal(container.textContent, "Copied");
  assert.ok(scheduledDelays.includes(6000));
});

test("a failed Assistant resize releases its open claim so opening can retry", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-open-failure-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  let resizeCalls = 0;
  let assistant;

  function Harness() {
    assistant = useAssistantPanel({
      requestMainWindowSize: async () => {
        resizeCalls += 1;
        throw new Error("resize failed");
      },
      dictationErrorActionCount: 0,
      recordingControlsRef: { current: null },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  await assistant.openPanel();
  await assistant.openPanel();

  assert.equal(resizeCalls, 2);
  assert.equal(assistant.openRef.current, false);
});

test("a failed live-transcript resize releases its open claim so opening can retry", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-live-transcript-open-failure-test-",
  });
  const { useLiveTranscriptPanel } = await vite.ssrLoadModule("/hooks/useLiveTranscriptPanel.js");
  let resizeCalls = 0;
  let liveTranscript;

  function Harness() {
    liveTranscript = useLiveTranscriptPanel({
      resizeToContent: async () => {
        resizeCalls += 1;
        throw new Error("resize failed");
      },
      assistantOpenRef: { current: false },
      isRecording: true,
      isProcessing: false,
      isAssistantVoice: false,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  liveTranscript.reopen();
  await new Promise((resolve) => setImmediate(resolve));
  liveTranscript.reopen();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(resizeCalls, 2);
  assert.equal(liveTranscript.openRef.current, false);
});

test("a caret-delivered command returns the hidden Assistant to the idle pill", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-caret-settlement-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  const { createRoot } = require("react-dom/client");
  let assistant;

  function Harness() {
    assistant = useAssistantPanel({
      requestMainWindowSize: async () => ({ success: true }),
      dictationErrorActionCount: 0,
      recordingControlsRef: { current: null },
    });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  await React.act(async () => {
    assistant.handleCommand({
      text: "draft a reply",
      attachment: null,
      selectedContext: null,
      delivery: {
        mode: "paste",
        sessionId: "caret-session",
        restoreClipboard: true,
        allowClipboardFallback: false,
      },
    });
  });
  assert.equal(assistant.mounted, true);
  assert.equal(assistant.open, false);

  await React.act(async () => {
    assistant.handleCommandSettled(1, { showPanel: false });
  });
  assert.equal(assistant.mounted, false);
  assert.equal(assistant.open, false);
  assert.equal(assistant.thinking, false);
});

test("a follow-up into an open panel strips caret delivery and stays panel-first", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-followup-delivery-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  const { createRoot } = require("react-dom/client");
  let assistant;

  function Harness() {
    assistant = useAssistantPanel({
      requestMainWindowSize: async () => ({ success: true }),
      dictationErrorActionCount: 0,
      recordingControlsRef: { current: null },
    });
    return null;
  }

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const delivery = {
    mode: "paste",
    sessionId: "caret-session",
    restoreClipboard: true,
    allowClipboardFallback: false,
  };

  assistant.openRef.current = true;
  await React.act(async () => {
    assistant.handleCommand({ text: "draft a reply", attachment: null, selectedContext: null, delivery });
  });
  assert.equal(assistant.pendingCommand.delivery, null);

  assistant.openRef.current = false;
  await React.act(async () => {
    assistant.handleCommand({ text: "draft a reply", attachment: null, selectedContext: null, delivery });
  });
  assert.deepEqual(assistant.pendingCommand.delivery, delivery);
});
