const assert = require("node:assert/strict");
const test = require("node:test");

test("saved sessions default to no helper and preserve explicit pending permission", async () => {
  const { createOnboardingSession, parseOnboardingSession } =
    await import("../../src/components/onboarding/flow.ts");
  const session = createOnboardingSession();
  assert.equal(session.permissionGuide, null);
  delete session.permissionGuide;
  const parse = (permissionGuide) =>
    parseOnboardingSession(JSON.stringify({ ...session, permissionGuide })).permissionGuide;
  assert.equal(parse(undefined), null);
  assert.deepEqual(parse({ current: "screen-context" }), { current: "screen-context" });
  assert.equal(parse({ current: "files" }), null);
  assert.deepEqual(parse({ current: "accessibility", history: ["microphone"] }), {
    current: "accessibility",
  });
});
