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
      "activation-mode",
      "dictation-demo",
      "assistant-hotkey",
      "assistant-demo",
      "notes",
      "setup-choice",
    ]
  );
});

test("guest flow keeps permissions and the hotkey before setup choice", async () => {
  const { getOnboardingRoute } = await load();
  // finalizeOnboarding registers the dictation hotkey on every path, so guests
  // must still grant the mic and see the key they are getting.
  assert.deepEqual(getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true }), [
    "auth",
    "permissions",
    "dictation-hotkey",
    "activation-mode",
    "setup-choice",
  ]);
});

test("every dictation route restores activation mode setup after shortcut capture", async () => {
  const { getOnboardingRoute } = await load();
  const accountRoute = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
  });
  const guestRoute = getOnboardingRoute({
    authPath: "guest",
    setupMode: null,
    agentAllowed: true,
  });

  assert.equal(accountRoute[accountRoute.indexOf("dictation-hotkey") + 1], "activation-mode");
  assert.equal(guestRoute[guestRoute.indexOf("dictation-hotkey") + 1], "activation-mode");
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
    [
      "auth",
      "permissions",
      "dictation-hotkey",
      "activation-mode",
      "setup-choice",
      "byok-dictation",
      "byok-assistant",
    ]
  );
  assert.deepEqual(
    getOnboardingRoute({ authPath: "account", setupMode: "local", agentAllowed: false }).slice(-2),
    ["setup-choice", "local-dictation"]
  );
});

test("a confirmed enterprise workspace ends the account route at notes", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
    skipSetupChoice: true,
  });
  assert.equal(route.at(-1), "notes");
  assert.equal(route.includes("setup-choice"), false);
});

test("enterprise workspace entitlement requires a current paid entitlement", async () => {
  const { isEnterpriseWorkspaceEntitled } = await load();
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "active" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "trialing" }), true);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "enterprise", status: "past_due" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled({ plan: "pro", status: "active" }), false);
  assert.equal(isEnterpriseWorkspaceEntitled(null), false);
});

test("only a signed-in account with an uncommitted choice skips enterprise setup", async () => {
  const { shouldSkipOnboardingSetupChoice } = await load();
  const base = {
    isSignedIn: true,
    authPath: "account",
    setupMode: null,
    activeWorkspace: { plan: "enterprise", status: "active" },
  };

  assert.equal(shouldSkipOnboardingSetupChoice(base), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "cloud" }), true);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, setupMode: "local" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, authPath: "guest" }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, isSignedIn: false }), false);
  assert.equal(shouldSkipOnboardingSetupChoice({ ...base, activeWorkspace: null }), false);
});

test("a fresh multi-workspace account resolves its enterprise workspace", async () => {
  const { resolveEnterpriseWorkspaceForOnboarding } = await load();
  const personal = { id: "personal", plan: "pro", status: "active" };
  const enterprise = { id: "enterprise", plan: "enterprise", status: "trialing" };

  assert.equal(resolveEnterpriseWorkspaceForOnboarding(null, [personal, enterprise]), enterprise);
  assert.equal(resolveEnterpriseWorkspaceForOnboarding(personal, [personal, enterprise]), null);
  assert.equal(
    resolveEnterpriseWorkspaceForOnboarding(enterprise, [personal, enterprise]),
    enterprise
  );
});

test("versioned sessions reject malformed or old data", async () => {
  const { createOnboardingSession, parseOnboardingSession } = await load();
  assert.equal(parseOnboardingSession(null), null);
  assert.equal(parseOnboardingSession("not json"), null);
  assert.equal(parseOnboardingSession('{"version":1,"currentStepId":"auth"}'), null);

  const session = createOnboardingSession();
  assert.deepEqual(parseOnboardingSession(JSON.stringify(session)), session);

  const legacyV2 = { ...session };
  delete legacyV2.selfHostedRequested;
  assert.equal(parseOnboardingSession(JSON.stringify(legacyV2)).selfHostedRequested, false);
  assert.equal(
    parseOnboardingSession(JSON.stringify({ ...session, selfHostedRequested: "yes" })),
    null
  );
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
  // Old steps 1-2 predate the old permissions step, so they must resume at
  // the new flow's permissions step rather than past it.
  assert.equal(migrateLegacyOnboardingStep("1"), "permissions");
  assert.equal(migrateLegacyOnboardingStep("2"), "permissions");
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
  assert.equal(getNextOnboardingStep("auth", route), "permissions");
  assert.equal(getNextOnboardingStep("setup-choice", route), null);
});

test("progress counts every step the user is shown, once each", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });

  // The compact steps render in a frame with no footer, so they carry no row and
  // must not inflate the total — landing on languages is "1 of 9", not "3 of 11".
  assert.equal(getOnboardingProgress("auth", route), null);
  assert.equal(getOnboardingProgress("permissions", route), null);

  const counted = route.filter((stepId) => getOnboardingProgress(stepId, route) !== null);
  assert.deepEqual(
    counted.map((stepId) => getOnboardingProgress(stepId, route).index),
    counted.map((_, index) => index)
  );
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 0, total: 9 });
  assert.deepEqual(getOnboardingProgress("setup-choice", route), { index: 8, total: 9 });
});

test("progress total tracks the conditional parts of the route", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const context = { authPath: "account", setupMode: null, agentAllowed: true };

  // Dropping the assistant pair shortens the row rather than leaving two dots
  // that can never fill.
  const noAgent = getOnboardingRoute({ ...context, agentAllowed: false });
  assert.equal(getOnboardingProgress("languages", noAgent).total, 7);
  assert.deepEqual(getOnboardingProgress("setup-choice", noAgent), { index: 6, total: 7 });

  // Picking a non-cloud mode appends the provider pair, so the row grows by two
  // at that moment and the last provider step is what fills it.
  const byok = getOnboardingRoute({ ...context, setupMode: "byok" });
  assert.deepEqual(getOnboardingProgress("setup-choice", byok), { index: 8, total: 11 });
  assert.deepEqual(getOnboardingProgress("byok-assistant", byok), { index: 10, total: 11 });
});

test("progress counts only the guest steps that draw a footer", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  // auth and permissions are compact, so the pre-plan guest route counts
  // dictation-hotkey, activation-mode and setup-choice: a three-dot row.
  const guest = getOnboardingRoute({ authPath: "guest", setupMode: null, agentAllowed: true });
  assert.deepEqual(getOnboardingProgress("setup-choice", guest), { index: 2, total: 3 });

  const guestByok = getOnboardingRoute({
    authPath: "guest",
    setupMode: "byok",
    agentAllowed: true,
  });
  assert.deepEqual(getOnboardingProgress("setup-choice", guestByok), { index: 2, total: 5 });

  // An off-route step has no position to report.
  assert.equal(getOnboardingProgress("notes", guestByok), null);
});

test("required models insert a blocking step right after auth — account path only", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
    requiredModelsPending: true,
  });
  assert.deepEqual(route.slice(0, 3), ["auth", "required-models", "permissions"]);

  // Guests never fetch a policy, so the gate cannot apply to them.
  const guest = getOnboardingRoute({
    authPath: "guest",
    setupMode: null,
    agentAllowed: true,
    requiredModelsPending: true,
  });
  assert.equal(guest.includes("required-models"), false);

  // Absent flag (older callers, nothing missing) leaves the route unchanged.
  const noFlag = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });
  assert.equal(noFlag.includes("required-models"), false);
});

test("required-models coexists with policy- and enterprise-shortened routes", async () => {
  const { getOnboardingRoute } = await load();
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: false,
    requiredModelsPending: true,
    skipSetupChoice: true,
  });
  assert.deepEqual(route.slice(0, 3), ["auth", "required-models", "permissions"]);
  assert.equal(route.at(-1), "notes");
  assert.equal(route.includes("assistant-hotkey"), false);
});

test("an off-route required-models session clamps to a neighbour step", async () => {
  const { getOnboardingRoute, reconcileStepWithRoute } = await load();
  // The session latch normally keeps the step on-route; if a stale session
  // still names it after the requirement went away across restarts, it must
  // clamp next to auth/permissions rather than teleport down the route.
  const route = getOnboardingRoute({ authPath: "account", setupMode: null, agentAllowed: true });
  assert.ok(["auth", "permissions"].includes(reconcileStepWithRoute("required-models", route)));
});

test("the required-models step is counted in progress", async () => {
  const { getOnboardingProgress, getOnboardingRoute } = await load();
  const route = getOnboardingRoute({
    authPath: "account",
    setupMode: null,
    agentAllowed: true,
    requiredModelsPending: true,
  });
  assert.deepEqual(getOnboardingProgress("required-models", route), { index: 0, total: 10 });
  assert.deepEqual(getOnboardingProgress("languages", route), { index: 1, total: 10 });
});

test("the tray suppression predicate matches only an active required-models session", async () => {
  const { createOnboardingSession, isRequiredModelsOnboardingStepActive } = await load();

  assert.equal(isRequiredModelsOnboardingStepActive(null), false);
  assert.equal(isRequiredModelsOnboardingStepActive("not json"), false);

  const session = createOnboardingSession();
  assert.equal(isRequiredModelsOnboardingStepActive(JSON.stringify(session)), false);
  assert.equal(
    isRequiredModelsOnboardingStepActive(
      JSON.stringify({ ...session, currentStepId: "required-models" })
    ),
    true
  );
  // A completed/cleared session (the post-onboarding state) never suppresses.
  assert.equal(
    isRequiredModelsOnboardingStepActive(
      JSON.stringify({ ...session, currentStepId: "permissions" })
    ),
    false
  );
});
