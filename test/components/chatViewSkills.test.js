const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { SKILLS_MOCKS, ariaLabel, click, findAll, settle } = require("../lib/skillsHarness");

// ChatView with its real message sender. The streaming hook records each send and its
// options; the composer renders its leading row, so the chip is real and clickable.
const MOCKS = {
  "react-i18next": SKILLS_MOCKS["react-i18next"],
  "/useChatStreaming": `
    import { useCallback } from "react";
    export function useChatStreaming(options) {
      globalThis.__chatStreamingOptions = options;
      const sendToAI = useCallback(async (text, _messages, sendOptions) => {
        globalThis.__sends.push({ text, options: sendOptions });
      }, []);
      const state = {
        agentState: globalThis.__agentState ?? "idle",
        toolStatus: "",
        activeToolName: "",
      };
      return { ...state, sendToAI, cancelStream() {} };
    }
  `,
  "/useChatPersistence": `
    export function useChatPersistence() {
      return {
        conversationId: null,
        messages: [],
        setMessages() {},
        createConversation: async () => 1,
        saveUserMessage: async () => {},
        saveAssistantMessage() {},
        loadConversation: async () => [],
        handleNewChat() {
          globalThis.__newChats += 1;
        },
      };
    }
  `,
  "/ChatInput": `
    import { createElement } from "react";
    export function ChatInput(props) {
      globalThis.__chatInput = props;
      return createElement("div", null, props.leadingRow, createElement("textarea"));
    }
  `,
  "/ConversationList": `
    export default function ConversationList(props) {
      globalThis.__conversationList = props;
      return null;
    }
  `,
  "/ChatMessages": `
    import { createElement } from "react";
    import { useSkillChatActions } from "/components/chat/skillChatActions.ts";
    export function ChatMessages({ emptyState }) {
      globalThis.__skillChatActions = useSkillChatActions();
      return createElement("div", null, emptyState);
    }
  `,
  "/ui/dialog": `export function ConfirmDialog() { return null; }`,
  "/hooks/useDialogs": `
    export function useDialogs() {
      return { confirmDialog: { open: false }, showConfirmDialog() {}, hideConfirmDialog() {} };
    }
  `,
};

const TRY_MEETING_PREP = { id: 1, kind: "try", name: "meeting-prep", displayName: "Meeting prep" };

async function renderChatView(t, skillRequest = null) {
  let root = null;
  const calls = { handled: 0, opened: [] };
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of [
      "__sends",
      "__newChats",
      "__chatInput",
      "__conversationList",
      "__chatStreamingOptions",
      "__skillChatActions",
      "__agentState",
    ]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  globalThis.__sends = [];
  globalThis.__newChats = 0;
  const { createRoot } = require("react-dom/client");
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-view-skills-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ChatView, {
        skillRequest,
        onSkillRequestHandled: () => (calls.handled += 1),
        onOpenSkill: (name) => calls.opened.push(name),
      })
    )
  );
  await settle();

  const chip = () =>
    findAll(container, (node) => ariaLabel(node).startsWith("skills.chat.chipRemove"))[0];
  const send = async (text) => {
    await React.act(async () => globalThis.__chatInput.onTextSubmit(text));
    await settle();
    return globalThis.__sends.at(-1).options;
  };
  return { container, calls, chip, send };
}

const chipLabel = (name) => `skills.chat.chipRemove${JSON.stringify({ name })}`;
const focusedTag = () => globalThis.document.activeElement?.tagName;
const picks = { name: "meeting-prep", displayName: "Meeting prep" };

test("Try now opens a new chat with the skill's chip and placeholder", async (t) => {
  const { container, calls, chip, send } = await renderChatView(t, TRY_MEETING_PREP);

  assert.equal(globalThis.__chatStreamingOptions.skillsEnabled, true);
  assert.equal(globalThis.__newChats, 1, "a new chat started");
  assert.equal(calls.handled, 1);
  assert.equal(ariaLabel(chip()), chipLabel("Meeting prep"));
  assert.match(container.textContent, /Meeting prep/);
  assert.equal(
    globalThis.__chatInput.placeholder,
    `skills.chat.placeholderWith${JSON.stringify({ name: "Meeting prep" })}`
  );
  assert.equal(focusedTag(), "TEXTAREA");
  // The chip's icon drops in as it arrives.
  const playing = (node) => /skill-icon-play/.test(node.getAttribute("class") ?? "");
  assert.equal(findAll(container, playing).length, 1);

  const options = await send("Prep my 3pm with Dana");
  assert.deepEqual(options.attachedSkill, { name: "meeting-prep" });
  assert.equal(options.allowSkillPick, true);
});

test("Create with assistant opens a new chat with the creator chip and its opening line", async (t) => {
  const { container, chip, send } = await renderChatView(t, { id: 2, kind: "create" });

  assert.equal(ariaLabel(chip()), chipLabel("skills.chat.creatorName"));
  assert.match(container.textContent, /skills\.chat\.creatorOpening/);
  assert.doesNotMatch(container.textContent, /chat\.starters\./, "no starter prompts");
  assert.equal(globalThis.__chatInput.placeholder, "chat.inputPlaceholder");

  const options = await send("I write the same weekly report every Friday");
  assert.deepEqual(options.attachedSkill, { name: "skill-creator", builtin: true });
});

test("Draft with assistant sends the name and description into the creator chat", async (t) => {
  const draft = { title: "Weekly report", description: "", instructions: "", fileNames: [] };
  await renderChatView(t, { id: 3, kind: "create", draft });

  assert.equal(globalThis.__sends.length, 1);
  const [{ text, options }] = globalThis.__sends;
  assert.equal(
    text,
    `skills.chat.draftPrompt${JSON.stringify({
      name: "Weekly report",
      description: "skills.chat.noneYet",
    })}`
  );
  assert.deepEqual(options.attachedSkill, { name: "skill-creator", builtin: true });
});

test("removing the chip drops the skill from the next send", async (t) => {
  const { chip, send } = await renderChatView(t, TRY_MEETING_PREP);

  await click(chip());

  assert.equal(chip(), undefined);
  assert.equal(globalThis.__chatInput.placeholder, "chat.inputPlaceholder");
  assert.equal(focusedTag(), "TEXTAREA");
  const options = await send("Prep my 3pm with Dana");
  assert.equal(options.attachedSkill, undefined);
  assert.equal(options.allowSkillPick, true, "the user removed a chip they attached");
});

test("a removed skill stays off the chat until a new one starts", async (t) => {
  const { chip, send } = await renderChatView(t, TRY_MEETING_PREP);

  await click(chip());
  const afterRemove = await send("What's the capital of France?");
  assert.deepEqual(afterRemove.removedSkills, ["meeting-prep"]);

  await React.act(async () => globalThis.__conversationList.onNewChat());
  const afterNewChat = await send("Hello");
  assert.deepEqual(afterNewChat.removedSkills, []);
});

test("removing a picked chip stops picking in that chat", async (t) => {
  const { chip, send } = await renderChatView(t);

  const first = await send("Prep my 3pm with Dana");
  assert.equal(first.allowSkillPick, true);
  await React.act(async () => first.onSkillPicked(picks));
  assert.equal(ariaLabel(chip()), chipLabel("Meeting prep"));
  const second = await send("And the 4pm");
  assert.deepEqual(second.attachedSkill, { name: "meeting-prep" }, "a picked chip stays on");

  await click(chip());

  const third = await send("And the 5pm");
  assert.equal(third.attachedSkill, undefined);
  assert.equal(third.allowSkillPick, false);
});

test("a new chat or another conversation clears the chip", async (t) => {
  const { chip, send } = await renderChatView(t, TRY_MEETING_PREP);

  await React.act(async () => globalThis.__conversationList.onNewChat());
  assert.equal(chip(), undefined);
  const afterNewChat = await send("Prep my 3pm with Dana");
  assert.equal(afterNewChat.attachedSkill, undefined);

  // A picked chip, removed, turns picking off until the chat changes.
  await React.act(async () => afterNewChat.onSkillPicked(picks));
  await click(chip());
  await React.act(async () => globalThis.__conversationList.onSelectConversation(7));
  await settle();

  assert.equal(chip(), undefined);
  const afterSwitch = await send("What did we decide?");
  assert.equal(afterSwitch.attachedSkill, undefined);
  assert.equal(afterSwitch.allowSkillPick, true);
});

test("Open skill on a saved card goes to the skill", async (t) => {
  const { calls } = await renderChatView(t);

  await React.act(async () => globalThis.__skillChatActions.openSkill("meeting-prep"));

  assert.deepEqual(calls.opened, ["meeting-prep"]);
});

test("Draft with assistant hands the creator the form's instructions and file names", async (t) => {
  const draft = {
    title: "Weekly report",
    description: "",
    instructions: "## Steps\nSum up the week.",
    fileNames: ["references/example.md"],
  };
  await renderChatView(t, { id: 3, kind: "create", draft });

  const [sent] = globalThis.__sends;
  assert.match(sent.text, /skills\.chat\.draftPrompt/);
  assert.match(sent.text, /skills\.chat\.draftInstructions.*Sum up the week/s);
  assert.match(sent.text, /skills\.chat\.draftFiles.*references\/example\.md/);
  assert.deepEqual(sent.options.attachedSkill, { name: "skill-creator", builtin: true });
});

test("Draft with assistant on an empty form only opens the creator", async (t) => {
  await renderChatView(t, { id: 3, kind: "create" });

  assert.deepEqual(globalThis.__sends, []);
});

test("Open skill waits for the turn to finish", async (t) => {
  // Leaving the chat ends a running turn, and a turn holding only the card isn't saved then.
  globalThis.__agentState = "streaming";
  await renderChatView(t);

  assert.equal(globalThis.__skillChatActions.openSkill, undefined);
});

test("a conversation's skills come back when the user returns to it", async (t) => {
  const { chip, send } = await renderChatView(t);
  const select = async (id) => {
    await React.act(async () => globalThis.__conversationList.onSelectConversation(id));
    await settle();
  };

  await select(7);
  await React.act(async () => (await send("Prep my 3pm with Dana")).onSkillPicked(picks));
  await select(8);
  assert.equal(chip(), undefined);
  await select(7);
  assert.equal(ariaLabel(chip()), chipLabel("Meeting prep"));
  assert.deepEqual((await send("And the 4pm")).attachedSkill, { name: "meeting-prep" });

  // Removed, it stays off this chat, and picking stays off too.
  await click(chip());
  await select(8);
  await select(7);
  assert.equal(chip(), undefined);
  const afterReturn = await send("And the 5pm");
  assert.equal(afterReturn.allowSkillPick, false);
  assert.deepEqual(afterReturn.removedSkills, ["meeting-prep"]);
});

test("a request is handled once, however often the chat re-renders", async (t) => {
  const { calls, chip } = await renderChatView(t, TRY_MEETING_PREP);

  await click(chip());
  await React.act(async () => globalThis.__chatInput.onTextSubmit("Hello"));
  await settle();

  assert.equal(calls.handled, 1);
  assert.equal(globalThis.__newChats, 1);
  assert.equal(chip(), undefined);
});

// React's development build mounts, unmounts and remounts once; the real persistence ends a
// session on unmount, which would drop a send started during the first mount.
test("Draft with assistant sends once under React's development double mount", async (t) => {
  let root = null;
  const created = [];
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of ["__sends", "__chatInput", "__conversationList", "__chatStreamingOptions"]) {
      delete globalThis[key];
    }
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        createAgentConversation: async (title) => {
          created.push(title);
          return { id: 7 };
        },
        addAgentMessage: async () => {},
      },
    },
  });
  const container = installInteractiveDom(t);
  globalThis.__sends = [];
  const { createRoot } = require("react-dom/client");
  const { "/useChatPersistence": _persistence, ...mockModules } = MOCKS;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-view-skills-strict-test-",
    noExternal: ["react-i18next"],
    mockModules,
  });
  const { default: ChatView } = await vite.ssrLoadModule("/components/chat/ChatView.tsx");
  const draft = {
    title: "Weekly report",
    description: "Sums up my week.",
    instructions: "",
    fileNames: [],
  };
  const view = React.createElement(ChatView, {
    skillRequest: { id: 4, kind: "create", draft },
    onSkillRequestHandled() {},
  });

  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(React.StrictMode, null, view)));
  await settle();
  await settle();

  assert.equal(globalThis.__sends.length, 1);
  assert.equal(created.length, 1, "one conversation, and no empty one left behind");
});
