// Covers the core guarantee of Task 5 (streaming reply, per-word rise): once
// a paragraph has settled, it must never re-render as later tokens grow the
// tail — only the tail re-renders per token. A test that only inspects
// rendered markup cannot catch a re-render (two renders of unchanged content
// can look identical), so this mounts the REAL AssistantPanel with the REAL
// MarkdownRenderer/rehypeWordRise/splitStreamingMarkdown (nothing mocked
// along that path) via react-dom/client's createRoot, and watches actual DOM
// node identity across simulated streaming updates.
//
// Why DOM node identity is a decisive signal here (not just "probably fine"):
// MarkdownRenderer.tsx builds its react-markdown `components` map inline, as
// fresh arrow functions on every call — those functions ARE the React
// element "type" for each rendered tag. If StableAssistantMarkdown's memo
// bails out, MarkdownRenderer never runs again and nothing changes. If it
// does NOT bail out (the split broke), MarkdownRenderer runs again, produces
// a brand-new `components` map, and every one of its custom-typed elements
// (every <p>, <strong>, ...) gets a *different* type on the next reconcile —
// forcing React to unmount and remount them, not patch them in place. So an
// unwanted re-render is not a maybe here: it always changes DOM node
// identity for the whole settled subtree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

// Adapted from test/helpers/assistantPanel.test.js's installInteractiveDom —
// the minimal fake DOM this repo already uses to run react-dom's createRoot
// under Node for interactive (not just static-markup) component tests. Kept
// as a local copy rather than a shared import so this task's test stays
// self-contained; the two will drift only in the sense that either could be
// extracted later, not in behavior.
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

function findAllElements(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node.nodeType === 1 && predicate(node)) found.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return found;
}

// Mounts the REAL AssistantPanel with everything except its heavy app-wiring
// dependencies mocked (same list test/helpers/assistantPanel.test.js already
// proves works with createRoot) — crucially, /ui/MarkdownRenderer is NOT
// mocked, so the real split/memo/rehype pipeline under test actually runs.
async function mountStreamingAssistantPanel(t) {
  // t.after hooks run in registration order (FIFO), so the unmount hook must
  // be registered BEFORE installBrowserGlobals/installInteractiveDom's own
  // cleanup — otherwise window/document are already torn down by the time
  // root.unmount() runs, throwing "window is not defined" (mirrors the
  // ordering test/helpers/assistantPanel.test.js's proven tests use).
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  globalThis.__streamMessages = [];
  t.after(() => {
    delete globalThis.__streamMessages;
    delete globalThis.__setStreamMessages;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-streaming-reply-test-",
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
        import { useState } from "react";
        export function useChatPersistence() {
          const [messages, setMessages] = useState(globalThis.__streamMessages);
          globalThis.__setStreamMessages = setMessages;
          return {
            messages,
            setMessages,
            conversationId: null,
            async createConversation() { return 1; },
            async loadConversation() {},
            saveUserMessage() {},
            saveAssistantMessage() {},
            handleNewChat() { setMessages([]); },
          };
        }
      `,
      "/chat/useChatStreaming": `
        export function useChatStreaming() {
          return { agentState: "idle", activeToolName: null, toolStatus: "", cancelStream() {} };
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
      // /ui/MarkdownRenderer is deliberately NOT mocked — this test exists to
      // exercise the real split/memo/rehype pipeline, not a stand-in for it.
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
  const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
  const { createRoot } = require("react-dom/client");

  root = createRoot(container);

  await React.act(async () =>
    root.render(
      React.createElement(AssistantPanel, {
        pendingCommand: null,
        onCommandConsumed: noop,
        onCommandDiscarded: noop,
        onCommandSettled: noop,
        initialConversationId: null,
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
    )
  );

  const setAssistantMessage = async (content, isStreaming) => {
    await React.act(async () => {
      globalThis.__setStreamMessages([{ id: "assistant-1", role: "assistant", content, isStreaming }]);
    });
  };

  return { container, setAssistantMessage };
}

const findSettledParagraph = (container, text) =>
  findElement(container, (el) => el.tagName === "P" && el.textContent.includes(text));

const riseSpans = (container) =>
  findAllElements(container, (el) => el.tagName === "SPAN" && el.getAttribute("data-rise") === "true");

// EVERY word rehypeWordRise touches gets wrapped in a span carrying
// data-word-index, whether or not it also gets data-rise (a "no longer
// new" word keeps the wrapper span, just without the rise attributes). So
// "no rise spans" alone does not prove a paragraph skipped rehypeWordRise
// entirely — a word that arrived, then simply aged out of "new" before the
// next check, would also show zero data-rise spans while still being
// word-wrapped. This is the stronger, decisive signal for "rendered as
// plain markdown, never touched by the tail's word-wrap pipeline at all".
const wordWrappedSpans = (container) =>
  findAllElements(container, (el) => el.tagName === "SPAN" && el.getAttribute("data-word-index") !== null);

test("a settled paragraph keeps its DOM identity across tail-only growth, but genuinely re-renders once new content joins it — and the whole reply collapses to one plain block when streaming ends", async (t) => {
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // Stage 1: two settled paragraphs plus a two-word tail.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot", true);
  const settledNode = findSettledParagraph(container, "Alpha bravo.");
  assert.ok(settledNode, "expected the first settled paragraph to be rendered");
  assert.equal(
    findSettledParagraph(container, "Charlie delta.")?.getAttribute("data-rise"),
    null,
    "settled paragraphs must never carry a rise trigger themselves"
  );
  assert.ok(riseSpans(container).length > 0, "expected the tail to actually be word-wrapped by rehypeWordRise");
  // No settled word is ever wrapped with a rise trigger — only tail words are.
  for (const span of riseSpans(container)) {
    assert.ok(
      "Echo foxtrot".includes(span.textContent),
      `a settled word ("${span.textContent}") must never carry a rise trigger`
    );
  }

  // Stage 2: tail grows (same settled prefix). The settled paragraph's own
  // DOM node must be the exact same object — not just equal-looking markup.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf", true);
  assert.equal(
    findSettledParagraph(container, "Alpha bravo."),
    settledNode,
    "the settled paragraph must keep its DOM identity while only the tail grows"
  );

  // Stage 3: tail grows again. Still the same settled node — two growths in a
  // row, not a one-off coincidence.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel", true);
  assert.equal(
    findSettledParagraph(container, "Alpha bravo."),
    settledNode,
    "the settled paragraph must still keep its DOM identity after a second tail growth"
  );

  // Stage 4: a new paragraph boundary passes — settled content itself
  // genuinely changes. This must NOT be a no-op: proves the test can tell
  // the difference between "didn't re-render" and "nothing ever changes".
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia", true);
  const settledNodeAfterBoundary = findSettledParagraph(container, "Alpha bravo.");
  assert.notEqual(
    settledNodeAfterBoundary,
    settledNode,
    "once new text actually joins the settled portion, it legitimately re-renders once (this is not the case the guarantee protects)"
  );
  assert.ok(
    findSettledParagraph(container, "Echo foxtrot golf hotel."),
    "the paragraph that just settled should render as plain, non-animated text"
  );
  assert.equal(
    findSettledParagraph(container, "Echo foxtrot golf hotel.").getAttribute("data-rise"),
    null
  );
  // The new (shorter) tail's own word must still actually rise — this is
  // the tail-shrink reset path (risenWordsRef resets to 0 when the new tail
  // is shorter than the old one, since a boundary just moved words out from
  // under it). Asserting only "no OTHER word wrongly rises" (the loop below)
  // would pass vacuously if this reset broke and "India" silently lost its
  // own rise trigger instead.
  const newTailSpans = riseSpans(container);
  assert.equal(newTailSpans.length, 1, 'expected exactly one rise span ("India") after the boundary reset');
  assert.equal(newTailSpans[0].textContent, "India");
  for (const span of newTailSpans) {
    assert.ok(
      "India".includes(span.textContent),
      `only the new tail ("India") may carry a rise trigger, not "${span.textContent}"`
    );
  }

  // Stage 5: streaming ends. Per the brief: "When streaming ends the whole
  // reply renders as one plain block" — no live tail, so no rise spans left
  // anywhere, even though the words that were briefly a tail are still on screen.
  await setAssistantMessage("Alpha bravo.\n\nCharlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia", false);
  assert.match(container.textContent, /India/);
  assert.equal(riseSpans(container).length, 0, "a finished reply must carry no rise triggers at all");
  // The stronger check: "India" must not be word-wrapped AT ALL (not even a
  // rise-less span carrying data-word-index) — it went through the plain
  // settled path, never through rehypeWordRise. "No rise spans" alone can
  // pass for the wrong reason: a word that ages out of "new" (see the
  // risenWordsRef reset above) also loses data-rise while still being
  // word-wrapped, which would make the split's failure to stop splitting at
  // end-of-stream invisible to a check that only looks for data-rise.
  assert.equal(
    wordWrappedSpans(container).length,
    0,
    "a finished reply must not be word-wrapped at all — it must never reach rehypeWordRise"
  );
});

test("the tail's per-word rise delay is wired to MOTION_TIMING.wordStaggerMs, not a retyped literal", async (t) => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { container, setAssistantMessage } = await mountStreamingAssistantPanel(t);

  // A tail that arrives as three words in a single update: firstNewWordIndex
  // is 0 for all three (nothing has risen yet), so their delays are 0, 1x,
  // and 2x the real stagger constant — computed from the import, never
  // retyped, so a future change to MOTION_TIMING.wordStaggerMs keeps this
  // test honest instead of quietly drifting.
  await setAssistantMessage("Echo foxtrot golf", true);
  const spans = riseSpans(container).sort(
    (a, b) => Number(a.getAttribute("data-word-index")) - Number(b.getAttribute("data-word-index"))
  );
  assert.deepEqual(
    spans.map((s) => s.textContent),
    ["Echo", "foxtrot", "golf"]
  );
  // React sets inline style properties via direct camelCase JS-property
  // assignment (node.style.animationDelay = ...), not node.style.setProperty
  // with the kebab-case CSS name — see react-dom's setValueForStyles.
  assert.deepEqual(
    spans.map((s) => s.style.animationDelay),
    [
      `${0 * MOTION_TIMING.wordStaggerMs}ms`,
      `${1 * MOTION_TIMING.wordStaggerMs}ms`,
      `${2 * MOTION_TIMING.wordStaggerMs}ms`,
    ]
  );
});
