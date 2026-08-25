const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/config/prompts.ts");

test("the agent prompt carries the current date, time, and timezone", async () => {
  const { getAgentSystemPrompt } = await load();

  const prompt = getAgentSystemPrompt();

  assert.match(
    prompt,
    /Current date and time: [A-Z][a-z]+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2} \(.+\)\./
  );
  assert.ok(prompt.includes(`(${Intl.DateTimeFormat().resolvedOptions().timeZone}).`));
});

test("registered tools get their instruction lines, unknown names are skipped", async () => {
  const { getAgentSystemPrompt } = await load();

  const prompt = getAgentSystemPrompt(["get_calendar_availability", "not_a_tool"]);

  assert.ok(prompt.includes("Use get_calendar_availability"));
  assert.ok(!prompt.includes("not_a_tool"));
});
