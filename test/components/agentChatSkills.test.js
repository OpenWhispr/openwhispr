const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const { SKILLS_MOCKS, ariaLabel, click, findAll, settle } = require("../lib/skillsHarness");

async function mountChat(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const calls = { sends: [], regenerated: [], streaming: null };
  globalThis.__agentSkillCalls = calls;
  t.after(() => delete globalThis.__agentSkillCalls);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-skills-",
    mockModules: {
      "react-i18next": SKILLS_MOCKS["react-i18next"],
      "/chat/useChatPersistence": `
        const messages = [
          { id: "u1", role: "user", content: "Prep my meeting", isStreaming: false },
          { id: "a1", role: "assistant", content: "Your prep", isStreaming: false },
        ];
        export function useChatPersistence() { return {
          messages, conversationId: 1, forkOrigin: null, setMessages() {},
          async createConversation() { return 1; },
          async loadConversation(id, beforeOpen) { beforeOpen?.(); return { id }; },
          getSessionVersion: () => 1,
          handleNewChat() {}, async forkConversation() { return 2; },
          saveAssistantMessage() {},
        }; }
      `,
      "/chat/useChatStreaming": `
        export function useChatStreaming(options) {
          globalThis.__agentSkillCalls.streaming = options;
          return { agentState: "idle", cancelStream() {},
            async sendToAI(text, messages, options) {
              globalThis.__agentSkillCalls.regenerated.push({ text, messages, options });
            },
          };
        }
      `,
      "/chat/useChatMessageSender": `
        export function useChatMessageSender() { return async (text, options) => {
          globalThis.__agentSkillCalls.sends.push({ text, options }); return true;
        }; }
      `,
      "/chat/useInterruptedInteractions": `export function useInterruptedInteractions() {}`,
    },
  });
  const [{ useAgentChat }, { AgentComposer }, { SkillChip }] = await Promise.all([
    vite.ssrLoadModule("/components/agent/useAgentChat.ts"),
    vite.ssrLoadModule("/components/agent/AgentComposer.tsx"),
    vite.ssrLoadModule("/components/chat/SkillChip.tsx"),
  ]);
  let chat;
  function Harness() {
    chat = useAgentChat({ onResponseContent() {}, onRegenerateFailed() {} });
    return React.createElement(AgentComposer, {
      draft: "",
      onDraftChange() {},
      onSubmit: chat.send,
      placeholder: "Ask",
      busy: false,
      onStop() {},
      micDisabled: false,
      focused: false,
      header:
        chat.pickedSkill &&
        React.createElement(SkillChip, {
          name: chat.pickedSkill.displayName,
          onRemove: chat.removePickedSkill,
        }),
    });
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const send = async (text, options) => {
    await React.act(async () => chat.send(text, options));
    await settle();
    return calls.sends.at(-1).options;
  };
  const pick = async () => {
    const options = await send("Prep my meeting");
    await React.act(async () =>
      options.onSkillPicked({ name: "meeting-prep", displayName: "Meeting prep" })
    );
  };
  return { calls, container, send, pick, chat: () => chat };
}

test("the assistant offers skills, keeps its picked skill, and lets the user remove its chip", async (t) => {
  const view = await mountChat(t);
  assert.equal(view.calls.streaming.skillsEnabled, true);
  await view.pick();
  const chip = findAll(view.container, (node) =>
    ariaLabel(node).startsWith("skills.chat.chipRemove")
  )[0];
  assert.ok(chip);
  const options = await view.send("And tomorrow?", {
    selectedContext: { text: "Agenda", sourceMessageId: "u1" },
  });
  assert.deepEqual(options.attachedSkill, { name: "meeting-prep" });
  assert.equal(options.selectedContext.text, "Agenda");
  await click(chip);
  const afterRemove = await view.send("And Friday?");
  assert.equal(afterRemove.attachedSkill, undefined);
  assert.equal(afterRemove.allowSkillPick, false);
});

test("new chat and switching conversations reset the assistant's skill choice", async (t) => {
  const view = await mountChat(t);
  await view.pick();
  await React.act(async () => view.chat().newChat());
  assert.equal(view.chat().pickedSkill, null);
  assert.equal((await view.send("A new task")).allowSkillPick, true);
  await view.pick();
  await React.act(async () => view.chat().switchChat(2));
  assert.equal(view.chat().pickedSkill, null);
});

test("regenerating an assistant answer keeps the skill it was using", async (t) => {
  const view = await mountChat(t);
  await view.pick();
  await React.act(async () => view.chat().regenerate(view.chat().messages[1]));
  assert.equal(view.calls.regenerated.length, 1);
  assert.deepEqual(view.calls.regenerated[0].options.attachedSkill, { name: "meeting-prep" });
});
