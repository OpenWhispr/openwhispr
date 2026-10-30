const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

// The row rendered with the English strings.
async function renderRow(t, message) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-progress-row-" });
  const [{ default: i18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!i18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }
  const { AgentProgressRow } = await vite.ssrLoadModule("/components/agent/AgentProgressRow.tsx");
  return renderToStaticMarkup(React.createElement(AgentProgressRow, { message }));
}

const call = (id, name, status, startedAt = 100) => ({
  id,
  name,
  arguments: "{}",
  status,
  startedAt,
});

test("several tools running at once show as one grouped step, with up to three logos", async (t) => {
  const markup = await renderRow(t, {
    id: "a",
    role: "assistant",
    content: "",
    isStreaming: true,
    turn: { startedAt: 100, status: "running" },
    toolCalls: [
      call("1", "slack_send_message", "executing"),
      call("2", "github_search_issues", "executing"),
      call("3", "search_notes", "executing"),
      call("4", "get_calendar_events", "executing"),
    ],
  });

  assert.match(markup, /Calling 4 tools…/);
  assert.equal((markup.match(/rounded-full border border-surface-0/g) ?? []).length, 3);
});

test("a regenerated reply doesn't count the sends its earlier turn made", async (t) => {
  const carried = { ...call("s1", "slack_send_message", "completed", 10), actionKey: "k" };
  const running = await renderRow(t, {
    id: "a",
    role: "assistant",
    content: "",
    isStreaming: true,
    turn: { startedAt: 100, status: "running" },
    toolCalls: [carried],
  });
  assert.match(running, /Thinking/);
  assert.doesNotMatch(running, /Checking answers/);

  const done = await renderRow(t, {
    id: "a",
    role: "assistant",
    content: "Done.",
    isStreaming: false,
    turn: { startedAt: 100, finishedAt: 3100, status: "complete", reasoning: "Plan." },
    toolCalls: [carried, call("q1", "search_notes", "completed", 200)],
  });
  assert.match(done, /Reasoned for 3s · 1 step</);
});

test("a turn saved while it waited, and never finished, shows no growing duration", async (t) => {
  const markup = await renderRow(t, {
    id: "a",
    role: "assistant",
    content: "Which tone?",
    isStreaming: false,
    turn: { startedAt: Date.now() - 86_400_000, status: "interrupted", reasoning: "Ask." },
    toolCalls: [],
  });
  assert.doesNotMatch(markup, /Reasoned for|Worked for/);
  assert.match(markup, />Reasoning</);
});

// zustand renders its initial state under renderToStaticMarkup, so a card on
// screen (a store entry) needs a real mount, where strings show as their keys.
async function mountRow(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-progress-row-" });
  const approvals = await vite.ssrLoadModule("/stores/connectorApprovalStore.ts");
  const interactions = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const { AgentProgressRow } = await vite.ssrLoadModule("/components/agent/AgentProgressRow.tsx");
  root = createRoot(container);
  const key = (id) => approvals.approvalKey("a", id);
  // The reply's steps, with the answer cards and question cards on screen.
  const show = async (steps, { cards = {}, questions = {} } = {}) => {
    approvals.useConnectorApprovalStore.setState({
      entries: Object.fromEntries(
        Object.entries(cards).map(([id, entry]) => [key(id), { key: key(id), ...entry }])
      ),
    });
    interactions.useAgentInteractionStore.setState({
      entries: Object.fromEntries(
        Object.entries(questions).map(([id, state]) => [
          key(id),
          { key: key(id), state, payload: { kind: "questions", questions: [] } },
        ])
      ),
    });
    const message = {
      id: "a",
      role: "assistant",
      content: "",
      isStreaming: true,
      turn: { startedAt: 100, status: "running" },
      toolCalls: steps,
    };
    await React.act(async () => root.render(React.createElement(AgentProgressRow, { message })));
    return container.textContent;
  };
  return show;
}

test("a running reply's row says nothing above a card that waits or sends, and checks answers after it", async (t) => {
  const show = await mountRow(t);
  const slack = (status) => [call("c1", "slack_send_message", status)];
  assert.equal(await show(slack("executing"), { cards: { c1: { state: "pending" } } }), "");
  assert.equal(
    await show(slack("executing"), { cards: { c1: { state: "committing" } } }),
    "",
    "the sending card says it"
  );
  assert.equal(
    await show(slack("executing"), { cards: { c1: { state: "failed", awaitingRetry: true } } }),
    "",
    "nor while a failed card waits for Retry"
  );
  assert.match(
    await show(slack("completed"), { cards: { c1: { state: "sent" } } }),
    /checkingAnswers/,
    "after Send the reply goes on"
  );
  assert.match(
    await show(slack("completed"), { cards: { c1: { state: "cancelled" } } }),
    /checkingAnswers/
  );

  const ask = [call("q1", "ask_user", "executing")];
  assert.equal(await show(ask, { questions: { q1: "pending" } }), "", "a question waits");
  assert.match(await show([{ ...ask[0], status: "completed" }]), /checkingAnswers/);
});

test("above a waiting card, a step that failed still shows, so it's seen before Send", async (t) => {
  const show = await mountRow(t);
  const steps = [
    { ...call("g1", "github_search_issues", "error"), result: "GitHub isn't connected." },
    call("c1", "slack_send_message", "executing"),
  ];
  const row = await show(steps, { cards: { c1: { state: "pending" } } });
  assert.match(row, /GitHub isn't connected\./);

  // A connector reports a failed search as a result, not a tool error.
  const reported = [
    {
      ...call("g1", "github_search_issues", "completed"),
      result: "That didn't work on GitHub.",
      metadata: { status: "failed", errorCode: "fixture_refused" },
    },
    call("c1", "slack_send_message", "executing"),
  ];
  assert.match(
    await show(reported, { cards: { c1: { state: "pending" } } }),
    /That didn't work on GitHub\./
  );
});
