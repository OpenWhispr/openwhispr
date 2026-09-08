const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installInteractiveDom,
  findElement,
} = require("../lib/rendererTestHarness");
const { renderAssistantPanel } = require("./renderAssistantPanel");

const noop = () => {};

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

test("closing retreats the footer actions on the close-fade duration, not the slower footer-handoff duration", async (t) => {
  const { MOTION_TIMING } = await import("../../src/utils/springEasing.ts");
  const { ASSISTANT_FOOTER_TRANSITION_TIMING } =
    await import("../../src/helpers/voicePillPresentation.js");

  const closingMarkup = await renderAssistantPanel(
    t,
    [{ id: "assistant-1", role: "assistant", content: "Existing answer", isStreaming: false }],
    { footerPhase: "actions", closing: true }
  );
  // Assert the actual DURATION VALUE landed in the style attribute, not just
  // that the actions container rendered — and derive the expectation from
  // MOTION_TIMING.closeFadeMs rather than retyping 120.
  assert.match(
    closingMarkup,
    new RegExp(`--assistant-actions-retreat-duration:\\s*${MOTION_TIMING.closeFadeMs}ms`)
  );
  assert.doesNotMatch(
    closingMarkup,
    new RegExp(
      `--assistant-actions-retreat-duration:\\s*${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsRetreatMs}ms`
    )
  );

  const openMarkup = await renderAssistantPanel(
    t,
    [{ id: "assistant-1", role: "assistant", content: "Existing answer", isStreaming: false }],
    { footerPhase: "actions", closing: false }
  );
  // Unchanged when the panel itself is not closing (e.g. the footer's own
  // ready->stale handoff): still the pre-existing footer-transition timing.
  assert.match(
    openMarkup,
    new RegExp(
      `--assistant-actions-retreat-duration:\\s*${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsRetreatMs}ms`
    )
  );
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

// The test above only proves useCopyFeedback itself honors whatever ms it is
// given — it renders a bare Harness, retypes the literal 6000, and never
// touches AssistantPanel. Fix round 1, finding 3: nothing in the suite pins
// that AssistantPanel's OWN auto-copy delivery path actually feeds it
// AUTO_COPY_FEEDBACK_MS — mutating that constant to 3000 left every test
// green. This drives the real pendingCommand → sendMessage → onComplete →
// deliverAssistantResponse → confirmCopied chain through the real component
// and asserts against the imported constant, never a retyped 6000.
test("the panel's own auto-copy delivery confirms the shared Copy button for AUTO_COPY_FEEDBACK_MS, not a retyped 6000", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const confirmCopiedCalls = [];
  globalThis.__assistantPanelConfirmCopiedCalls = confirmCopiedCalls;
  t.after(() => {
    delete globalThis.__assistantPanelConfirmCopiedCalls;
  });
  // deliverAssistantResponse (real, unmocked) resolves `copied: true` via
  // this stub the moment its electronAPI.writeClipboard branch succeeds —
  // no need to mock the delivery helper itself.
  installBrowserGlobals(t, {
    window: { electronAPI: { writeClipboard: async () => ({ success: true }) } },
  });
  const container = installInteractiveDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-auto-copy-hold-panel-test-",
    mockModules: {
      "/chat/useChatPersistence": `
        export function useChatPersistence() {
          return {
            messages: [],
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
          return { agentState: "idle", activeToolName: null, toolStatus: "", cancelStream() {} };
        }
      `,
      // Bypasses the real send/stream pipeline entirely: calls onComplete
      // synchronously with canned content, exercising AssistantPanel's OWN
      // glue code (deliverAssistantResponse + confirmCopied(content,
      // AUTO_COPY_FEEDBACK_MS)) without needing a real backend.
      "/chat/useChatMessageSender": `
        export function useChatMessageSender() {
          return async (text, options) => {
            if (options && options.onComplete) {
              await options.onComplete({ content: "the delivered answer" });
            }
            return true;
          };
        }
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
          return {
            copied: false,
            async copy() {},
            confirmCopied(content, ms) {
              globalThis.__assistantPanelConfirmCopiedCalls.push([content, ms]);
            },
          };
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
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  await viteI18next.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation } },
    interpolation: { escapeValue: false },
  });
  const { AssistantPanel, AUTO_COPY_FEEDBACK_MS } = await vite.ssrLoadModule(
    "/components/dictation/AssistantPanel.tsx"
  );
  const { createRoot } = require("react-dom/client");

  root = createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(AssistantPanel, {
        pendingCommand: {
          id: 1,
          text: "hello",
          attachment: null,
          selectedContext: null,
          delivery: { mode: "clipboard" },
        },
        onCommandConsumed: noop,
        onCommandDiscarded: noop,
        onCommandSettled: noop,
        initialConversationId: null,
        onConversationIdChange: noop,
        voiceState: "idle",
        thinking: false,
        open: true,
        footerPhase: "actions",
        horizontalDirection: "right",
        onClose: noop,
        onBusyChange: noop,
        onResponseReadyChange: noop,
        onResponseContent: noop,
        onConversationReset: noop,
        onSelectionContextChange: noop,
      })
    );
  });
  // The pendingCommand effect's sendMessage(...).then(...) chain (and the
  // mocked sender's own awaited onComplete inside it) resolve as
  // microtasks beyond the act() pass that triggered them.
  await React.act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.deepEqual(
    confirmCopiedCalls,
    [["the delivered answer", AUTO_COPY_FEEDBACK_MS]],
    "the auto-copy delivery must confirm using the panel's own AUTO_COPY_FEEDBACK_MS constant"
  );
  assert.equal(
    AUTO_COPY_FEEDBACK_MS,
    6000,
    "sanity: still the value the brief pinned — a change here is a deliberate retune, not silent drift"
  );
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

test("completeCollapse waits for both close intent and the content fade to finish before unmounting", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-collapse-guard-test-",
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
  await React.act(async () => assistant.openPanel());
  assert.equal(assistant.mounted, true);

  // Before any close intent: a pure no-op.
  await React.act(async () => assistant.completeCollapse());
  assert.equal(assistant.mounted, true, "completeCollapse before any close intent must be a no-op");

  // Close intent alone, before the content fade reports completion: still a
  // no-op — the shell hasn't even begun its own close spring yet.
  await React.act(async () => assistant.handleClose());
  assert.equal(assistant.closing, true);
  await React.act(async () => assistant.completeCollapse());
  assert.equal(
    assistant.mounted,
    true,
    "completeCollapse must wait for the content fade, not just close intent"
  );

  // Once the content fade has completed, completeCollapse actually unmounts.
  await React.act(async () => assistant.completeContentFade());
  assert.equal(assistant.open, false);
  await React.act(async () => assistant.completeCollapse());
  assert.equal(assistant.mounted, false);
  assert.equal(assistant.closing, false);
});

test("the fallback timer collapses the panel on its own, timed to ASSISTANT_COLLAPSE_FALLBACK_MS, if nothing reports the shell's own transitionend", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-collapse-fallback-test-",
  });
  const { useAssistantPanel, ASSISTANT_COLLAPSE_FALLBACK_MS } = await vite.ssrLoadModule(
    "/hooks/useAssistantPanel.js"
  );
  const { createRoot } = require("react-dom/client");
  t.mock.timers.enable({ apis: ["setTimeout"] });

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
  await React.act(async () => assistant.openPanel());
  await React.act(async () => assistant.handleClose());
  await React.act(async () => assistant.completeContentFade());
  assert.equal(
    assistant.mounted,
    true,
    "fixture: still mounted right after the content fade completes"
  );

  // Derived from the real exported constant, never a retyped 560.
  await React.act(async () => {
    t.mock.timers.tick(ASSISTANT_COLLAPSE_FALLBACK_MS - 1);
  });
  assert.equal(assistant.mounted, true, "must not collapse before the pinned fallback elapses");

  await React.act(async () => {
    t.mock.timers.tick(1);
  });
  assert.equal(assistant.mounted, false);
  assert.equal(assistant.closing, false);
});

// Deviation from the brief's literal fallback line, flagged in the task
// report: src/index.css strips clip-path from transition-property under
// reduced motion (the task's own documented trap, "Task 3 lost a round to
// exactly this"), so the shell's own onCollapsed can never fire there and
// this fallback becomes the ONLY path to completeCollapse. Falling all the
// way through to the full 560ms fallback would leave a visibly collapsed
// shell sitting inside a still-expanded native window for over half a
// second — the window shrink is gated on `mounted`, and nothing else moves
// it. Mirrors the established resolvePillShrinkWait convention (resolve at
// once under reduced motion) instead of leaning on a generic timeout.
test("reduced motion collapses the panel at once instead of waiting the full fallback", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { matchMedia: () => ({ matches: true }) } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-collapse-reduced-motion-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  const { createRoot } = require("react-dom/client");
  t.mock.timers.enable({ apis: ["setTimeout"] });

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
  await React.act(async () => assistant.openPanel());
  await React.act(async () => assistant.handleClose());
  await React.act(async () => assistant.completeContentFade());
  assert.equal(
    assistant.mounted,
    true,
    "fixture: still mounted immediately after the content fade"
  );

  await React.act(async () => {
    t.mock.timers.tick(1);
  });
  assert.equal(
    assistant.mounted,
    false,
    "reduced motion must not wait for a clip-path transitionend that can never fire, nor the full fallback"
  );
});

test("closing with a ready response retreats the footer actions immediately instead of waiting for the normal handoff", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-close-footer-retreat-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  const { createRoot } = require("react-dom/client");
  t.mock.timers.enable({ apis: ["setTimeout"] });

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
  await React.act(async () => assistant.openPanel());
  assert.equal(
    assistant.open,
    true,
    "fixture: the panel must be genuinely open for the footer effect to run"
  );

  await React.act(async () => assistant.setResponseReady(true));
  assert.equal(
    assistant.footerPhase,
    "pill-exiting",
    "fixture: the normal ready handoff begins by retreating the pill"
  );

  await React.act(async () => assistant.handleClose());
  assert.equal(
    assistant.footerPhase,
    "actions-exiting",
    "a close intent while a response was ready must retreat the ACTIONS, not continue the pill/actions handoff"
  );
});

// Finding 2, final review 2026-09-08. ASSISTANT_COLLAPSE_FALLBACK_MS was the
// hand-written literal 560, and the only test on it imported the constant
// itself — so ANY value kept that test green. 560 happened to be
// settleFallbackMs(MOTION_TIMING.morphMs); retuning morphMs 440 -> 600 (the
// one knob the plan says owns the close spring) would have left the fallback
// firing 40ms BEFORE the morph landed, unmounting the panel mid-transition
// and handing useMainWindowSizeOwner's returning-from-panel branch a native
// resize during a visible transition — the one thing spec section 3 forbids.
// Both fallbacks are now derived; this binds them to what they cover.
test("the assistant close's fallbacks are derived from the motion they cover, not hand-written", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-fallback-binding-test-",
  });
  const { ASSISTANT_COLLAPSE_FALLBACK_MS, ASSISTANT_CONTENT_FADE_FALLBACK_MS } =
    await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
  const { ASSISTANT_CLOSE_TIMING } = await vite.ssrLoadModule("/helpers/voicePillPresentation.js");
  const { MOTION_TIMING } = await vite.ssrLoadModule("/utils/springEasing.ts");
  const { settleFallbackMs } = await vite.ssrLoadModule("/utils/transitionSettled.ts");

  assert.equal(
    ASSISTANT_COLLAPSE_FALLBACK_MS,
    settleFallbackMs(MOTION_TIMING.morphMs),
    "the collapse fallback must follow the morph duration it is a net for"
  );
  assert.ok(
    ASSISTANT_COLLAPSE_FALLBACK_MS > MOTION_TIMING.morphMs,
    "a collapse fallback at or under the morph unmounts the panel mid-transition"
  );
  assert.equal(
    ASSISTANT_CONTENT_FADE_FALLBACK_MS,
    ASSISTANT_CLOSE_TIMING.guaranteeMs,
    "the hook's content-fade guarantee is the shared close timing's, not a third number"
  );
  assert.ok(
    ASSISTANT_CONTENT_FADE_FALLBACK_MS > ASSISTANT_CLOSE_TIMING.reportMs,
    "the core reports first; the hook only guarantees what the core could not report"
  );
});
