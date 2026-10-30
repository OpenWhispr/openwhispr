const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// i18n is not initialized, so labels render as their keys: the fork chip is
// "chat.forkedFrom".

async function renderList(t, { messages, forkOrigin }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-message-list-" });
  const { AgentMessageList } = await vite.ssrLoadModule("/components/agent/AgentMessages.tsx");
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(AgentMessageList, {
      messages,
      forkOrigin,
      onOpenParent: noop,
      busy: false,
      readAloud: { available: false, speakingId: null, toggle: noop },
      onRegenerate: noop,
      onFork: noop,
      onFollowUp: noop,
      onContinue: noop,
      emptyState: null,
    })
  );
}

const message = (id, role, content) => ({
  id,
  dbId: Number(id.slice(1)),
  role,
  content,
  isStreaming: false,
});
const MESSAGES = [
  message("m1", "user", "Draft the plan"),
  message("m2", "assistant", "Here is the plan."),
  message("m3", "user", "Shorter, please"),
  message("m4", "assistant", "A shorter plan."),
];

test("a fork's chip sits where the copied history ends and its own turns begin", async (t) => {
  const markup = await renderList(t, {
    messages: MESSAGES,
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 2,
    },
  });
  const chip = markup.indexOf("chat.forkedFrom");
  assert.ok(chip > markup.indexOf("Here is the plan."));
  assert.ok(chip < markup.indexOf("Shorter, please"));
});

test("a fork that copied nothing it can place shows its chip at the top", async (t) => {
  const markup = await renderList(t, {
    messages: MESSAGES,
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 0,
    },
  });
  assert.ok(markup.indexOf("chat.forkedFrom") < markup.indexOf("Draft the plan"));
});

test("a fork whose copied history ends on a tool row keeps its chip after the last shown message", async (t) => {
  const markup = await renderList(t, {
    messages: [
      MESSAGES[0],
      MESSAGES[1],
      { id: "t1", role: "tool", content: "{}", isStreaming: false },
      MESSAGES[2],
    ],
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 3,
    },
  });
  const chip = markup.indexOf("chat.forkedFrom");
  assert.ok(chip > markup.indexOf("Here is the plan."));
  assert.ok(chip < markup.indexOf("Shorter, please"));
});
