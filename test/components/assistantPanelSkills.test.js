const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { SKILLS_MOCKS, ariaLabel, click, findAll, settle } = require("../lib/skillsHarness");

const noop = () => {};

// The voice panel with its chat hooks replaced: sends are recorded with their options, and
// the composer renders its leading row so a chip is real and clickable.
function panelMocks({ realMarkdown = false } = {}) {
  return {
    "react-i18next": SKILLS_MOCKS["react-i18next"],
    "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
    "/chat/useChatPersistence": `
      export function useChatPersistence() {
        return {
          messages: globalThis.__panelMessages,
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
      export function useChatStreaming(options) {
        globalThis.__panelStreamingOptions = options;
        return {
          agentState: "idle",
          activeToolName: globalThis.__panelActiveToolName ?? null,
          toolStatus: "",
          cancelStream() {},
        };
      }
    `,
    "/chat/useChatMessageSender": `
      export function useChatMessageSender() {
        return async (text, options) => {
          globalThis.__panelSends.push({ text, options });
          return true;
        };
      }
    `,
    "/chat/ChatInput": `
      import { createElement } from "react";
      export function ChatInput(props) {
        globalThis.__panelInput = props;
        return createElement("div", null, props.leadingRow, createElement("textarea"));
      }
    `,
    "/chat/SkillApprovalCard": `
      import { createElement } from "react";
      import { useSkillChatActions } from "/components/chat/skillChatActions.ts";
      export function SkillApprovalCard({ entry }) {
        const { openSkill } = useSkillChatActions();
        return createElement("div", {
          "data-skill-card": entry.toolCallId,
          "data-open-skill": openSkill ? "yes" : "no",
        });
      }
    `,
    "/hooks/useWindowDrag": `
      export function useWindowDrag() { return { handleMouseDown() {}, handleMouseUp() {} }; }
    `,
    "/hooks/useCopyFeedback": `
      export function useCopyFeedback() {
        const copyText = async () => true;
        return { copied: false, async copy() {}, copyText, confirmCopied() {} };
      }
    `,
    "/stores/settingsStore": `
      const state = { voiceAgentKey: [] };
      export function useSettingsStore(selector) { return selector(state); }
    `,
    "/utils/hotkeys": `export function formatHotkeyListLabel() { return ""; }`,
    ...(realMarkdown
      ? {}
      : {
          "/ui/MarkdownRenderer": `
            import React from "react";
            export function MarkdownRenderer({ content }) {
              return React.createElement("div", null, content);
            }
          `,
        }),
  };
}

const PANEL_PROPS = {
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
  skillChoice: { picked: null, pickOff: false },
  onSkillChoiceChange: noop,
};

// Browser globals (and, for a mount, the DOM) come first: react-dom reads them as it loads.
async function loadPanel(t, { messages = [], activeToolName = null, realMarkdown } = {}) {
  globalThis.__panelMessages = messages;
  globalThis.__panelActiveToolName = activeToolName;
  globalThis.__panelSends = [];
  t.after(() => {
    for (const key of [
      "__panelMessages",
      "__panelActiveToolName",
      "__panelSends",
      "__panelStreamingOptions",
      "__panelInput",
    ]) {
      delete globalThis[key];
    }
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-skills-test-",
    noExternal: ["react-i18next"],
    mockModules: panelMocks({ realMarkdown }),
  });
  const { AssistantPanel } = await vite.ssrLoadModule("/components/dictation/AssistantPanel.tsx");
  return { vite, AssistantPanel };
}

async function mountPanel(t, props, options) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  // The tool-activity line rotates on an interval while a tool runs.
  installBrowserGlobals(t, { window: { setInterval: () => 1, clearInterval() {} } });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const loaded = await loadPanel(t, options);
  // The panel's owner keeps the conversation's skill choice, as useAssistantPanel does.
  function Owner() {
    const [skillChoice, setSkillChoice] = React.useState(
      props.skillChoice ?? { picked: null, pickOff: false }
    );
    return React.createElement(loaded.AssistantPanel, {
      ...PANEL_PROPS,
      ...props,
      skillChoice,
      onSkillChoiceChange: (choice) => {
        props.onSkillChoiceChange?.(choice);
        setSkillChoice(choice);
      },
    });
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Owner)));
  await settle();
  return { ...loaded, container };
}

const COMMAND = {
  id: 1,
  text: "Prep my 3pm with Dana",
  attachment: null,
  selectedContext: null,
  delivery: null,
};

test("the voice panel shows a picked skill's chip", async (t) => {
  const { container } = await mountPanel(t, { pendingCommand: COMMAND });
  const chip = () =>
    findAll(container, (node) => ariaLabel(node).startsWith("skills.chat.chipRemove"))[0];
  const typed = async (text) => {
    await React.act(async () => globalThis.__panelInput.onTextSubmit(text));
    await settle();
    return globalThis.__panelSends.at(-1).options;
  };

  assert.equal(globalThis.__panelStreamingOptions.skillsEnabled, true);
  const [spoken] = globalThis.__panelSends;
  assert.equal(spoken.text, COMMAND.text);
  assert.equal(spoken.options.allowSkillPick, true);
  assert.equal(chip(), undefined);

  await React.act(async () =>
    spoken.options.onSkillPicked({ name: "meeting-prep", displayName: "Meeting prep" })
  );
  assert.equal(
    ariaLabel(chip()),
    `skills.chat.chipRemove${JSON.stringify({ name: "Meeting prep" })}`
  );
  assert.deepEqual((await typed("And the 4pm")).attachedSkill, { name: "meeting-prep" });

  await click(chip());

  assert.equal(chip(), undefined);
  const afterRemove = await typed("And the 5pm");
  assert.equal(afterRemove.attachedSkill, undefined);
  assert.equal(afterRemove.allowSkillPick, false);
});

// The panel unmounts when it closes; the conversation, and the skill it uses, outlive it.
test("a reopened voice panel keeps the conversation's picked skill and its removal", async (t) => {
  const changes = [];
  const { container } = await mountPanel(t, {
    pendingCommand: null,
    skillChoice: { picked: { name: "meeting-prep", displayName: "Meeting prep" }, pickOff: false },
    onSkillChoiceChange: (choice) => changes.push(choice),
  });
  const chip = () =>
    findAll(container, (node) => ariaLabel(node).startsWith("skills.chat.chipRemove"))[0];

  assert.equal(Boolean(chip()), true);
  await React.act(async () => globalThis.__panelInput.onTextSubmit("And the 4pm"));
  await settle();
  assert.deepEqual(globalThis.__panelSends.at(-1).options.attachedSkill, { name: "meeting-prep" });

  await click(chip());

  assert.deepEqual(changes.at(-1), { picked: null, pickOff: true });
});

test("the voice panel renders skill cards", async (t) => {
  const messages = [
    { id: "user-1", role: "user", content: "Make that a skill", isStreaming: false },
    {
      id: "assistant-1",
      role: "assistant",
      content: "",
      isStreaming: true,
      toolCalls: [{ id: "call-1", name: "propose_skill", arguments: "{}", status: "executing" }],
    },
  ];
  const { vite, container } = await mountPanel(
    t,
    { pendingCommand: null },
    { messages, activeToolName: "propose_skill" }
  );
  const store = await vite.ssrLoadModule("/stores/skillApprovalStore.ts");
  const { approvalKey } = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const key = approvalKey("assistant-1", "call-1");
  await React.act(async () =>
    store.useSkillApprovalStore.setState({
      entries: {
        [key]: {
          key,
          kind: "create",
          messageId: "assistant-1",
          toolCallId: "call-1",
          name: "weekly-report",
          state: "pending",
          draft: { title: "Weekly report", description: "d", instructions: "i" },
          original: { title: "Weekly report", description: "d", instructions: "i" },
        },
      },
    })
  );

  const [card] = findAll(container, (node) => node.getAttribute("data-skill-card") === "call-1");
  assert.ok(card, "the card is shown");
  assert.equal(card.getAttribute("data-open-skill"), "no", "no Open skill in this window");
  assert.equal(
    findAll(container, (node) => node.getAttribute("data-tool-invocation") !== null).length,
    0,
    "a card waiting on the user is not covered by the tool overlay"
  );
});

test("voice panel code blocks offer Paste into app", async (t) => {
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Run this:\n\n```sh\nls -la\n```\n",
      isStreaming: false,
    },
  ];
  installBrowserGlobals(t);
  const { AssistantPanel } = await loadPanel(t, { messages, realMarkdown: true });
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(AssistantPanel, { ...PANEL_PROPS, pendingCommand: null, ...props })
    );

  const markup = render({ canPasteIntoApp: true });
  assert.match(markup, /skills\.code\.paste/);
  assert.match(markup, /common\.copy/);

  // Opened from the tray or the pill menu, or over OpenWhispr itself: no app to paste into.
  const copyOnly = render({ canPasteIntoApp: false });
  assert.doesNotMatch(copyOnly, /skills\.code\.paste/);
  assert.match(copyOnly, /common\.copy/);
});

test("Paste into app waits for the answer to finish streaming", async (t) => {
  // Half a command can read as another one, and a one-line block can still grow lines.
  const messages = [
    {
      id: "assistant-1",
      role: "assistant",
      content: "Run this:\n\n```sh\nrm -rf ./",
      isStreaming: true,
    },
  ];
  installBrowserGlobals(t);
  const { AssistantPanel } = await loadPanel(t, { messages, realMarkdown: true });

  const markup = renderToStaticMarkup(
    React.createElement(AssistantPanel, {
      ...PANEL_PROPS,
      pendingCommand: null,
      canPasteIntoApp: true,
    })
  );

  assert.doesNotMatch(markup, /skills\.code\.paste/);
  assert.match(markup, /common\.copy/);
});

test("a voice command adopts its app as the paste target; the tray and a close drop it", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const calls = [];
  let available = true;
  installBrowserGlobals(t, {
    window: {
      setInterval: () => 1,
      clearInterval() {},
      electronAPI: {
        assistantPasteTarget: async (action) => {
          calls.push(action);
          return action === "adopt" && available;
        },
      },
    },
  });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-paste-target-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
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

  await React.act(async () => assistant.handleCommand({ text: "How do I list files?" }));
  assert.deepEqual(calls, ["adopt"]);
  assert.equal(assistant.canPasteIntoApp, true);

  await React.act(async () => assistant.handleClose());
  await React.act(async () => assistant.completeContentFade());
  assert.equal(assistant.canPasteIntoApp, false);

  // Main finds no usable app (OpenWhispr was in front): Copy only.
  available = false;
  await React.act(async () => assistant.handleCommand({ text: "And hidden files?" }));
  assert.equal(assistant.canPasteIntoApp, false);

  await React.act(async () => assistant.handleClose());
  await React.act(async () => assistant.completeContentFade());
  // The panel unmounts once its closing transition ends.
  await React.act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  await React.act(async () => assistant.openPanel());
  assert.equal(calls.at(-1), "forget");
  assert.equal(assistant.canPasteIntoApp, false);
});

test("the panel's owner keeps the skill choice through a close, and resets it", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { setInterval: () => 1, clearInterval() {} } });
  const container = installInteractiveDom(t);
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-panel-skill-choice-test-",
  });
  const { useAssistantPanel } = await vite.ssrLoadModule("/hooks/useAssistantPanel.js");
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
  const picked = { picked: { name: "meeting-prep", displayName: "Meeting prep" }, pickOff: false };

  await React.act(async () => assistant.setSkillChoice(picked));
  await React.act(async () => assistant.setConversationId(42));
  await React.act(async () => assistant.handleClose());
  await React.act(async () => assistant.completeContentFade());
  assert.deepEqual(assistant.skillChoice, picked, "kept while the conversation is");

  await React.act(async () => assistant.handleConversationReset());
  assert.deepEqual(assistant.skillChoice, { picked: null, pickOff: false });

  // A conversation that is gone (deleted, or it failed to load) takes its choice with it.
  await React.act(async () => assistant.setSkillChoice(picked));
  await React.act(async () => assistant.setConversationId(null));
  assert.deepEqual(assistant.skillChoice, { picked: null, pickOff: false });
});
