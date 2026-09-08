// Shared static-render helper for the real AssistantPanel.tsx component.
// Extracted out of assistantPanel.test.js (which still uses it, alongside
// its own interactive-mount tests) so a second test file — currently
// assistantCopyTickMotion.test.js — can render the SAME component with the
// SAME mock set, varying only what it needs, without either duplicating this
// ~90-line mock map or `require`-ing a sibling .test.js file (which would
// re-register and re-run that file's own tests as a side effect of import).
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

async function renderAssistantPanel(
  t,
  messages,
  {
    initialConversationId = null,
    agentState = "idle",
    activeToolName = null,
    locale = "en",
    // "pill" (the default, matching every pre-existing caller) never mounts
    // the footer's action buttons at all (resolveAssistantFooterPresentation
    // gates actionsMounted on the phase) — the Copy button lives there, so
    // reaching it requires "actions".
    footerPhase = "pill",
    // Task 7: whether the WHOLE panel is closing, not just the footer's own
    // phase — feeds --assistant-actions-retreat-duration so a close intent
    // retreats the actions on the close-fade's own duration instead of the
    // footer's normal (slower) internal handoff duration.
    closing = false,
    // copied drives the mocked useCopyFeedback return value; copiedLabel,
    // when set, replaces useCrossfadedLabel entirely with a fixed
    // { showActive, fading } pair — the only way to reach the mid-fade
    // (fading: true) state from a static render, since that state is only
    // ever produced by the real hook's effect, which renderToStaticMarkup
    // never runs.
    copied = false,
    copiedLabel = null,
  } = {}
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

  const mockModules = {
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
        return { copied: ${copied}, async copy() {}, confirmCopied() {} };
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
  };
  if (copiedLabel) {
    // Bypasses the real hook's timing entirely so a static render can land
    // directly on a state (fading: true) the real effect-driven hook can
    // only reach after a re-render this harness never performs.
    mockModules["/hooks/useCrossfadedLabel"] = `
      export function useCrossfadedLabel() {
        return ${JSON.stringify(copiedLabel)};
      }
    `;
  }
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-test-",
    mockModules,
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
      footerPhase,
      closing,
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

module.exports = { renderAssistantPanel };
