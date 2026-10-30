const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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
