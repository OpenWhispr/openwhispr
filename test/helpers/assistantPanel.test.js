const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

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
        export function useCopyFeedback() { return { copied: false, async copy() {} }; }
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
