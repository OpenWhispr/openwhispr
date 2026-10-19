const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// useInterruptedInteractions mounted for real over a stand-in persistence:
// which interrupted questions come back, and what answering one does.
const QUESTION = {
  kind: "questions",
  questions: [{ id: "city", kind: "text", prompt: "Which city?" }],
};
const interrupted = (id) => ({
  id,
  name: "ask_user",
  arguments: "{}",
  status: "executing",
  interaction: { payload: QUESTION, state: "interrupted" },
});
const reply = (id, toolCalls) => ({
  id,
  role: "assistant",
  content: "",
  isStreaming: false,
  turn: { startedAt: 1, finishedAt: 2, status: "interrupted" },
  toolCalls,
});
const user = (id) => ({ id, role: "user", content: "Hi", isStreaming: false });

async function mount(t, initial) {
  let root;
  // Node runs after hooks in registration order: unmount while the DOM exists.
  t.after(() => root && React.act(async () => root.unmount()));
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-interrupted-interactions-test-",
  });
  const [{ default: i18n }, { useInterruptedInteractions }, store] = await Promise.all([
    vite.ssrLoadModule("/i18n.ts"),
    vite.ssrLoadModule("/components/chat/useInterruptedInteractions.ts"),
    vite.ssrLoadModule("/stores/agentInteractionStore.ts"),
  ]);
  await i18n.changeLanguage("en");
  store.useAgentInteractionStore.setState({ entries: {} });
  const { createRoot } = require("react-dom/client");

  const saved = [];
  const sent = [];
  let messages = initial;
  let sendLabel = "first";
  let rerender;
  function Harness() {
    const [list, setList] = React.useState(messages);
    messages = list;
    rerender = setList;
    const label = sendLabel;
    useInterruptedInteractions(
      {
        messages: list,
        setMessages: setList,
        conversationId: 7,
        saveAssistantMessage: async (...args) => saved.push(args),
      },
      async (text) => {
        sent.push([label, text]);
        return true;
      }
    );
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    store,
    saved,
    sent,
    entries: () => store.useAgentInteractionStore.getState().entries,
    setMessages: (next) => React.act(async () => rerender(next)),
    useSend: (label) => (sendLabel = label),
    act: (fn) => React.act(async () => fn()),
    unmount: () => React.act(async () => root.unmount()),
  };
}

test("an answer continues the task with the conversation as it is then", async (t) => {
  const chat = await mount(t, [user("u1"), reply("a1", [interrupted("q1")])]);
  assert.deepEqual(Object.keys(chat.entries()), ["a1::q1"]);

  // The chat re-renders (a newer sender) before the user answers.
  chat.useSend("latest");
  await chat.setMessages((list) => [...list]);
  await chat.act(() => {
    chat.store.updateInteractionDraft("a1::q1", { city: "Lisbon" });
    chat.store.answerQuestions("a1::q1");
  });

  const [[messageId, , toolCalls, details]] = chat.saved;
  assert.equal(messageId, "a1");
  assert.equal(details.conversationId, 7, "saved to the conversation it was restored in");
  assert.deepEqual(toolCalls[0].interaction.result, {
    status: "answered",
    answers: { city: "Lisbon" },
  });
  assert.deepEqual(chat.sent, [["latest", "Which city?\nLisbon"]]);
});

test("only the last reply's questions come back, and they go when the chat moves on", async (t) => {
  const chat = await mount(t, [reply("a0", [interrupted("q0")]), user("u1"), reply("a1", [])]);
  assert.deepEqual(chat.entries(), {}, "an earlier reply's question stays unanswered");

  await chat.setMessages([user("u1"), reply("a2", [interrupted("q2")])]);
  assert.deepEqual(Object.keys(chat.entries()), ["a2::q2"]);
  await chat.setMessages((list) => [...list, user("u2")]);
  assert.deepEqual(chat.entries(), {});
  assert.equal(chat.store.answerQuestions("a2::q2"), false);
  assert.deepEqual(chat.saved, []);
  assert.deepEqual(chat.sent, []);
});

test("leaving the chat takes its restored questions away unanswered", async (t) => {
  const chat = await mount(t, [user("u1"), reply("a1", [interrupted("q1")])]);
  await chat.unmount();
  assert.deepEqual(chat.entries(), {});
  assert.deepEqual(chat.saved, []);
});
