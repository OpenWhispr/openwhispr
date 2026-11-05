const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const load = () => import("../../src/components/onboarding/setupEligibility.ts");

const TRANSCRIPTION_PROVIDERS = [{ id: "openai" }, { id: "groq" }];
const LLM_PROVIDERS = [{ id: "anthropic" }, { id: "groq" }];

function managedPolicy({ transcription, llm }) {
  return {
    status: "managed",
    appVersion: "1.0.0",
    policy: {
      version: 1,
      transcription,
      llm,
      features: { agentEnabled: true, webSearchEnabled: true },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  };
}

function availability(policy, overrides = {}) {
  return load().then(({ getOnboardingSetupAvailability }) =>
    getOnboardingSetupAvailability({
      policy,
      agentAllowed: true,
      transcriptionProviders: TRANSCRIPTION_PROVIDERS,
      llmProviders: LLM_PROVIDERS,
      supportedLocalTranscriptionModels: [{ id: "base" }],
      ...overrides,
    })
  );
}

test("BYOK requires a usable provider for both stages", async () => {
  const base = {
    transcription: { allowedModes: ["providers"], allowedByokProviders: [] },
    llm: {
      allowedModes: ["providers"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  };
  assert.equal((await availability(managedPolicy(base))).byok, false);

  base.transcription.allowedByokProviders = ["groq"];
  assert.equal((await availability(managedPolicy(base))).byok, false);

  base.llm.allowedByokProviders = ["anthropic"];
  assert.equal((await availability(managedPolicy(base))).byok, true);
});

test("self-hosted eligibility is independent from hosted provider mode", async () => {
  const result = await availability(
    managedPolicy({
      transcription: { allowedModes: ["self-hosted"], allowedByokProviders: ["custom"] },
      llm: {
        allowedModes: ["self-hosted"],
        allowedByokProviders: ["custom"],
        allowedEnterpriseProviders: [],
      },
    })
  );

  assert.equal(result.byok, false);
  assert.equal(result.selfHosted, true);
});

test("availability reports no setup when policy permits no onboarding mode", async () => {
  const policy = managedPolicy({
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: [],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  });

  const result = await availability(policy);
  assert.deepEqual(result, {
    cloud: false,
    local: false,
    byok: false,
    selfHosted: false,
  });
});

test("dictation-only policies ignore LLM availability when the agent is disabled", async () => {
  const policy = managedPolicy({
    transcription: {
      allowedModes: ["openwhispr", "local", "providers", "self-hosted"],
      allowedByokProviders: ["groq", "custom"],
    },
    llm: {
      allowedModes: [],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  });
  policy.policy.features.agentEnabled = false;

  // Only Local can skip the assistant: its step shows the blocked notice and a Skip.
  assert.deepEqual(await availability(policy, { agentAllowed: true }), {
    cloud: false,
    local: true,
    byok: false,
    selfHosted: false,
  });

  const result = await availability(policy, { agentAllowed: false });
  assert.deepEqual(result, {
    cloud: true,
    local: true,
    byok: true,
    selfHosted: true,
  });
});

test("local setup requires an approved device-supported speech model, whatever AI text allows", async () => {
  const policy = managedPolicy({
    transcription: { allowedModes: ["local"], allowedLocalModels: ["orukeet-v0.1.0"] },
    llm: { allowedModes: ["local"], allowedLocalModels: [] },
  });
  assert.equal((await availability(policy, { agentAllowed: false })).local, false);
  assert.equal(
    (
      await availability(policy, {
        agentAllowed: false,
        supportedLocalTranscriptionModels: [{ id: "orukeet-v0.1.0" }],
      })
    ).local,
    true
  );
  // No approved AI text model, and then no Local AI text at all.
  const speechOnDevice = { supportedLocalTranscriptionModels: [{ id: "orukeet-v0.1.0" }] };
  assert.equal((await availability(policy, speechOnDevice)).local, true);
  policy.policy.llm.allowedModes = [];
  assert.equal((await availability(policy, speechOnDevice)).local, true);
  policy.policy.transcription.allowedLocalModels = ["future-speech"];
  assert.equal((await availability(policy, { agentAllowed: false })).local, false);
  assert.equal((await availability(policy, speechOnDevice)).local, false);
});

test("blocked speech hides Local even when AI text models are approved", async () => {
  const policy = managedPolicy({
    transcription: { allowedModes: [], allowedLocalModels: ["base"] },
    llm: { allowedModes: ["local"], allowedLocalModels: ["qwen3.5-4b-q4_k_m"] },
  });
  assert.equal((await availability(policy)).local, false);
});

test("Cohere-only speech approvals enable local setup only on a supported device", async () => {
  const modelId = "cohere-transcribe-03-2026";
  const policy = managedPolicy({
    transcription: { allowedModes: ["local"], allowedLocalModels: [modelId] },
    llm: { allowedModes: ["local"], allowedLocalModels: ["qwen3.5-4b-q4_k_m"] },
  });
  assert.equal((await availability(policy, { agentAllowed: false })).local, false);
  assert.equal(
    (
      await availability(policy, {
        agentAllowed: false,
        supportedLocalTranscriptionModels: [{ id: modelId }],
      })
    ).local,
    true
  );
  assert.equal(
    (
      await availability(policy, {
        supportedLocalTranscriptionModels: [{ id: modelId }],
      })
    ).local,
    true
  );
});

async function renderSetupChoice(t, policy, capability) {
  let unmount = async () => {};
  t.after(() => unmount());
  installBrowserGlobals(t, {
    window: { electronAPI: { checkParakeetInstallation: () => capability } },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-setup-choice-",
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
    },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState(policy);
  const { default: SetupChoiceStep } = await vite.ssrLoadModule(
    "/components/onboarding/SetupChoiceStep.tsx"
  );
  let tree;
  const selected = [];
  const props = {
    isSignedIn: true,
    agentAllowed: true,
    onSelect: (mode) => selected.push(mode),
    onRequestAuthentication() {},
  };
  function Harness() {
    tree = SetupChoiceStep(props);
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = async () => {
    await React.act(async () => root.unmount());
  };
  const has = (node, predicate) => {
    if (Array.isArray(node)) return node.some((child) => has(child, predicate));
    if (!node || typeof node !== "object") return false;
    return predicate(node) || has(node.props?.children, predicate);
  };
  const findByText = (node, text) => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const match = findByText(child, text);
        if (match) return match;
      }
      return null;
    }
    if (!node || typeof node !== "object") return null;
    return node.props?.children === text ? node : findByText(node.props?.children, text);
  };
  const press = (text) => React.act(async () => findByText(tree, text).props.onClick());
  return {
    selected,
    press,
    warningOpen: () =>
      has(tree, (node) => node.props?.open === true && "onOpenChange" in node.props),
    unavailable: () => has(tree, (node) => node.props?.role === "alert"),
    explainsLocal: () => has(tree, (node) => node.type?.name === "LocalModelPolicyNotice"),
    localCard: () =>
      has(tree, (node) => node.props?.children === "onboarding.rehaul.setupChoice.local.download"),
  };
}

const PARAKEET_ONLY = managedPolicy({
  transcription: { allowedModes: ["local"], allowedLocalModels: ["parakeet-tdt-0.6b-v3"] },
  llm: { allowedModes: ["local"], allowedLocalModels: [] },
});

test("a Parakeet-only list shows Local, not Unavailable, while the device check runs", async (t) => {
  let answer;
  const capability = new Promise((resolve) => {
    answer = resolve;
  });
  const step = await renderSetupChoice(t, PARAKEET_ONLY, capability);
  assert.equal(step.unavailable(), false);
  assert.equal(step.localCard(), true);

  await React.act(async () => answer({ supported: true }));
  assert.equal(step.localCard(), true);
});

test("a device that can't run Parakeet then loses a Parakeet-only Local", async (t) => {
  let answer;
  const capability = new Promise((resolve) => {
    answer = resolve;
  });
  const step = await renderSetupChoice(t, PARAKEET_ONLY, capability);
  await React.act(async () => answer({ supported: false }));
  assert.equal(step.localCard(), false);
  assert.equal(step.unavailable(), true);
  assert.equal(step.explainsLocal(), true, "the member learns why no setup is left");
});

test("a Local card the policy took away is explained beside the setups that remain", async (t) => {
  const step = await renderSetupChoice(
    t,
    managedPolicy({
      transcription: { allowedModes: ["local", "openwhispr"], allowedLocalModels: [] },
      llm: { allowedModes: ["openwhispr"] },
    }),
    Promise.resolve({ supported: true })
  );
  assert.equal(step.localCard(), false);
  assert.equal(step.unavailable(), false);
  assert.equal(step.explainsLocal(), true);
});

test("a member with Local available gets no explanation", async (t) => {
  const step = await renderSetupChoice(
    t,
    managedPolicy({
      transcription: { allowedModes: ["local", "openwhispr"], allowedLocalModels: ["base"] },
      llm: { allowedModes: ["openwhispr"] },
    }),
    Promise.resolve({ supported: true })
  );
  assert.equal(step.localCard(), true);
  assert.equal(step.explainsLocal(), false);
});

test("a warning opened before the device check can't start a setup that check ruled out", async (t) => {
  let answer;
  const capability = new Promise((resolve) => {
    answer = resolve;
  });
  const policy = managedPolicy({
    transcription: {
      allowedModes: ["local", "openwhispr"],
      allowedLocalModels: ["parakeet-tdt-0.6b-v3"],
    },
    llm: { allowedModes: ["openwhispr"], allowedLocalModels: [] },
  });
  const step = await renderSetupChoice(t, policy, capability);
  await step.press("onboarding.rehaul.setupChoice.local.download");
  assert.equal(step.warningOpen(), true);

  await React.act(async () => answer({ supported: false }));
  assert.equal(step.localCard(), false);
  await step.press("onboarding.rehaul.setupChoice.warnings.local.continue");
  assert.deepEqual(step.selected, []);
  assert.equal(step.warningOpen(), false, "the warning closes rather than doing nothing");
});
