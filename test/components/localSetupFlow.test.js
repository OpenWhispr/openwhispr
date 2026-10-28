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

test("Proceed writes the settings only once the finish can't fail, then hands off", async () => {
  const { planLocalSetup, proceedWithLocalSetup } = await load();
  const plan = planLocalSetup(input());
  const order = [];
  let onModelReady;
  const handOff = () => {
    order.push("handOff");
    return {
      ready: { cleanup: true, assistant: false },
      pending: ["assistant"],
      continueInBackground: (callback) => {
        order.push("continue");
        onModelReady = callback;
      },
    };
  };
  await proceedWithLocalSetup(
    plan,
    handOff,
    async (beforeComplete) => {
      order.push("checks");
      await Promise.resolve();
      beforeComplete();
      order.push("complete");
    },
    {
      apply: (appliedPlan, ready) => {
        assert.equal(appliedPlan, plan);
        assert.deepEqual(ready, { cleanup: true, assistant: false });
        order.push("apply");
      },
      remember: (rememberedPlan, pending) => {
        assert.equal(rememberedPlan, plan);
        assert.deepEqual(pending, ["assistant"]);
        order.push("remember");
      },
      activate: (modelId) => order.push(`activate ${modelId}`),
    }
  );
  assert.deepEqual(order, ["checks", "handOff", "apply", "remember", "continue", "complete"]);

  onModelReady({ kind: "llm", id: "qwen3.5-4b-q4_k_m", bytes: 1 });
  assert.equal(order.at(-1), "activate qwen3.5-4b-q4_k_m");
});

test("a finish that fails before its last step writes nothing", async () => {
  const { planLocalSetup, proceedWithLocalSetup } = await load();
  let tookOver = false;
  await proceedWithLocalSetup(
    planLocalSetup(input()),
    () => {
      tookOver = true;
      throw new Error("never taken");
    },
    async () => {}
  );
  assert.equal(tookOver, false, "the downloads stay on the step");
});
