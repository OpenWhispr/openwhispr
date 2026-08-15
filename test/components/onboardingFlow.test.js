const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/flow.ts");

test("account flow includes the complete guided setup", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(
    getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true }),
    [
      "auth",
      "permissions",
      "languages",
      "use-cases",
      "dictation-hotkey",
      "dictation-demo",
      "assistant-hotkey",
      "assistant-demo",
      "notes",
      "setup-choice",
    ]
  );
});

test("guest flow jumps directly to setup choice", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true }), [
    "auth",
    "setup-choice",
  ]);
});

test("policy removes assistant states", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: false });
  assert.equal(route.includes("assistant-hotkey"), false);
  assert.equal(route.includes("assistant-demo"), false);
  assert.equal(route.at(-1), "setup-choice");
});

test("setup choice appends the selected two-stage route", async () => {
  const { getOnboardingRoute } = await load();
  assert.deepEqual(
    getOnboardingRoute({ authPath: "guest", setupMode: "byok", agentAllowed: true }),
    ["auth", "setup-choice", "byok-dictation", "byok-assistant"]
  );
  assert.deepEqual(
    getOnboardingRoute({ authPath: "account", setupMode: "local", agentAllowed: false }).slice(-2),
    ["setup-choice", "local-dictation"]
  );
});

test("versioned sessions reject malformed or old data", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"auth"}'), null);

  const session = createOnboardingSession();
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);
});

test("legacy numeric steps migrate conservatively", async () => {
  const { migrateLegacyOnboardingStep } = await load();
  assert.equal(migrateLegacyOnboardingStep(null), "auth");
  assert.equal(migrateLegacyOnboardingStep("0"), "auth");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(getNextOnboardingStep("auth", route), "setup-choice");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});
