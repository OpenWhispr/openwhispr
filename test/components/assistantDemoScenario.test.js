const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/assistantDemoScenario.ts");

test("the assistant demo only promises what this machine can deliver", async () => {
  const { resolveAssistantDemoScenario } = await load();

  assert.equal(
    resolveAssistantDemoScenario({ calendarConnected: true, screenContextActive: true }),
    "calendarScreen"
  );
  assert.equal(
    resolveAssistantDemoScenario({ calendarConnected: false, screenContextActive: true }),
    "screen"
  );
  assert.equal(
    resolveAssistantDemoScenario({ calendarConnected: true, screenContextActive: false }),
    "calendar"
  );
  assert.equal(
    resolveAssistantDemoScenario({ calendarConnected: false, screenContextActive: false }),
    "general"
  );
});
