const test = require("node:test");
const assert = require("node:assert/strict");

// How OnboardingFlow wires the local setup step: what it builds the plan from,
// and what its Proceed does.
const load = () => import("../../src/components/onboarding/localSetupFlow.ts");

const mac = (o) => ({
  platform: "darwin",
  arch: "arm64",
  name: "MacBook Pro",
  formFactor: "laptop",
  processorName: "Apple M5 Pro",
  appleChip: { generation: 5, tier: "Pro" },
  memoryGb: 48,
  graphicsName: null,
  nvidia: null,
  parakeetSupported: true,
  systemLanguage: "en",
  ...o,
});
const policy = (status) => ({ status, policy: null, appVersion: null });
const input = (o) => ({
  profile: mac(),
  policy: policy("unmanaged"),
  guest: false,
  spokenLanguages: ["de"],
  requiredModelIds: [],
  ...o,
});

test("the plan waits for the computer read and a resolved policy", async () => {
  const { planLocalSetup } = await load();
  assert.equal(planLocalSetup(input({ profile: null })), null);
  // Loading or errored fails closed and would offer no rows at all.
  assert.equal(planLocalSetup(input({ policy: policy("loading") })), null);
  assert.equal(planLocalSetup(input({ policy: policy("error") })), null);
  for (const status of ["idle", "unmanaged"]) {
    assert.deepEqual(planLocalSetup(input({ policy: policy(status) })).languages, ["de"], status);
  }
});

test("a guest's plan follows the system language, not stored languages", async () => {
  const { planLocalSetup } = await load();
  const plan = planLocalSetup(input({ guest: true, profile: mac({ systemLanguage: "fr" }) }));
  assert.deepEqual(plan.languages, ["fr"]);
});

test("the first required speech model replaces the pick", async () => {
  const { planLocalSetup } = await load();
  const plan = planLocalSetup(
    input({ requiredModelIds: ["qwen3.5-2b-q4_k_m", "parakeet-tdt-0.6b-v3", "base"] })
  );
  const dictation = plan.rows.find((row) => row.id === "dictation");
  assert.equal(dictation.modelId, "parakeet-tdt-0.6b-v3", "the text model is skipped");
  assert.equal(dictation.line.key, "requiredByOrganization");
});

test("Proceed writes the settings, then finishes onboarding", async () => {
  const { planLocalSetup, proceedWithLocalSetup } = await load();
  const plan = planLocalSetup(input());
  const switches = { cleanup: true, assistant: false };
  const order = [];
  let finished = false;
  await proceedWithLocalSetup(
    plan,
    switches,
    async () => {
      order.push("finish");
      await Promise.resolve();
      finished = true;
    },
    (appliedPlan, appliedSwitches) => {
      assert.equal(appliedPlan, plan);
      assert.deepEqual(appliedSwitches, switches);
      order.push("apply");
    }
  );
  assert.deepEqual(order, ["apply", "finish"]);
  assert.equal(finished, true, "Proceed waits for the finish");
});
