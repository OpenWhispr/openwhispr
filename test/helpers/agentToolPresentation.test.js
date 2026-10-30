const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/agentToolPresentation.ts");

test("a fast tool step stays visible for its minimum time", async () => {
  const { AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS, getAgentToolActivityRemainingMs } = await load();

  assert.equal(AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS, 2400);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 10_500), 1900);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 12_500), 0);
});
