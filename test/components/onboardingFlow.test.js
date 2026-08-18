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

test("an explicit restart clears every persisted route choice and returns to auth", async () => {
  const { resetOnboardingProgress } = await load();
  const values = new Map([
    ["onboardingSessionV2", '{"currentStepId":"permissions"}'],
    ["onboardingCompleted", "true"],
    ["authenticationSkipped", "true"],
    ["skipAuth", "true"],
  ]);
  const storage = {
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  resetOnboardingProgress(storage);

  assert.equal(values.get("onboardingCurrentStep"), "0");
  assert.equal(values.has("onboardingSessionV2"), false);
  assert.equal(values.has("onboardingCompleted"), false);
  assert.equal(values.has("authenticationSkipped"), false);
  assert.equal(values.has("skipAuth"), false);
});

test("legacy numeric steps migrate conservatively", async () => {
  const { migrateLegacyOnboardingStep } = await load();
  assert.equal(migrateLegacyOnboardingStep(null), "auth");
  assert.equal(migrateLegacyOnboardingStep("0"), "auth");
  assert.equal(migrateLegacyOnboardingStep("4"), "dictation-hotkey");
  assert.equal(migrateLegacyOnboardingStep("999"), "setup-choice");
});

test("an off-route assistant step clamps to its neighbour, not the end of the route", async () => {
  const { getOnboardingRoute, reconcileStepWithRoute } = await load();
  // agentAllowed false is what a failed policy fetch produces, and it drops both
  // assistant steps from the route. Clamping to route.at(-1) used to land the user
  // on setup-choice, skipping notes and looking like a jump to the plan chooser.
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: false,
  });
  assert.equal(route.includes("assistant-hotkey"), false);
  assert.equal(reconcileStepWithRoute("assistant-hotkey", route), "dictation-demo");
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "notes");
  assert.notEqual(reconcileStepWithRoute("assistant-hotkey", route), "setup-choice");

  // With the agent allowed the steps are on the route and pass through untouched.
  const agentRoute = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
  });
  assert.equal(reconcileStepWithRoute("assistant-hotkey", agentRoute), "assistant-hotkey");
});

test("route helpers recover from ineligible steps", async () => {
  const { getNextOnboardingStep, getOnboardingRoute, reconcileStepWithRoute } = await load();
  const route = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true });
  assert.equal(reconcileStepWithRoute("assistant-demo", route), "setup-choice");
  assert.equal(getNextOnboardingStep("auth", route), "setup-choice");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});
