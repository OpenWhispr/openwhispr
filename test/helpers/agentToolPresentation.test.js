const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/agentToolPresentation.ts");

test("Agent tool labels keep tool identity readable without raw separators", async () => {
  const { formatAgentToolName } = await load();

  assert.equal(formatAgentToolName("search_notes"), "Search notes");
  assert.equal(formatAgentToolName("web-search"), "Web search");
  assert.equal(formatAgentToolName(" get_calendar_events "), "Get calendar events");
  assert.equal(formatAgentToolName(""), "Tool");
});

test("Agent tool activity uses a restrained rotating verb set", async () => {
  const {
    AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS,
    AGENT_TOOL_ACTIVITY_ROTATION_MS,
    AGENT_TOOL_ACTIVITY_VERBS,
    getAgentToolActivityRemainingMs,
  } = await load();

  assert.deepEqual([...AGENT_TOOL_ACTIVITY_VERBS], ["Invoking", "Calling", "Using"]);
  assert.equal(AGENT_TOOL_ACTIVITY_ROTATION_MS, 1400);
  assert.equal(AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS, 2400);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 10_500), 1900);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 12_500), 0);
});
