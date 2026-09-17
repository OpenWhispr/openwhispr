const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Signing in never switches a setting — a post-sign-in cloud switch is what overrode Local
// for #2086 — so a user who signed in from one of the Cloud entry points (#2128) is only
// told Cloud is there. requestSignIn leaves the marker this reads behind, because the
// sign-in it starts always crosses a reload.

const PROMPTED_AT_KEY = "signInPromptedAt";
const GUEST_ON_OWN_SETUP = {
  onboardingCompleted: "true",
  transcriptionMode: "providers",
  useLocalWhisper: "false",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "groq",
};

const managedPolicy = (allowedModes, allowedByokProviders) => ({
  version: 1,
  transcription: { allowedModes, allowedByokProviders, allowedEnterpriseProviders: [] },
  llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: false, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
});

async function mountNudge(t, { settings = {}, prompted = true } = {}) {
  let unmount = async () => {};
  t.after(() => unmount());
  const { storage } = installBrowserGlobals(t, {
    initialStorage: {
      ...(prompted ? { [PROMPTED_AT_KEY]: String(Date.now()) } : {}),
      ...GUEST_ON_OWN_SETUP,
      ...settings,
    },
  });
  const container = installHookDom(t);
  const toasts = [];
  const dismissed = [];
  globalThis.__cloudNudgeToasts = { toasts, dismissed };
  t.after(() => delete globalThis.__cloudNudgeToasts);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cloud-nudge-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ui/useToast": `
        function toast(props) {
          const { toasts } = globalThis.__cloudNudgeToasts;
          toasts.push(props);
          return "toast-" + toasts.length;
        }
        function dismiss(id) { globalThis.__cloudNudgeToasts.dismissed.push(id); }
        export function useToast() { return { toast, dismiss }; }
      `,
    },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSignInCloudNudge } = await vite.ssrLoadModule("/hooks/useSignInCloudNudge.tsx");

  let isSignedIn = false;
  let settingsOpened = 0;
  const openTranscriptionSettings = () => {
    settingsOpened += 1;
  };
  function Harness() {
    useSignInCloudNudge(isSignedIn, openTranscriptionSettings);
    return null;
  }
  const root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(Harness)));
  await render();
  let mounted = true;
  unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
  };

  return {
    storage,
    toasts,
    dismissed,
    rerender: render,
    settingsOpened: () => settingsOpened,
    signIn: async () => {
      isSignedIn = true;
      await render();
    },
    settlePolicy: (status = "unmanaged", policy = null) =>
      React.act(async () => usePolicyStore.setState({ status, policy, appVersion: "1.10.0" })),
  };
}

test("a sign-in nudges towards Cloud once the account's policy settles", async (t) => {
  const nudge = await mountNudge(t);
  await nudge.settlePolicy("loading");
  await nudge.signIn();
  assert.deepEqual(nudge.toasts, [], "no nudge before the policy can allow Cloud");
  assert.notEqual(nudge.storage.getItem(PROMPTED_AT_KEY), null);

  await nudge.settlePolicy();

  assert.equal(nudge.toasts.length, 1);
  assert.equal(nudge.toasts[0].title, "controlPanel.cloudNudge.title");
  assert.equal(nudge.toasts[0].description, "controlPanel.cloudNudge.description");
  assert.equal(nudge.storage.getItem(PROMPTED_AT_KEY), null);
  assert.equal(nudge.storage.getItem("transcriptionMode"), "providers");
  assert.equal(nudge.storage.getItem("cloudTranscriptionMode"), "byok");

  nudge.toasts[0].action.props.onClick();
  assert.deepEqual(nudge.dismissed, ["toast-1"]);
  assert.equal(nudge.settingsOpened(), 1);

  await nudge.rerender();
  assert.equal(nudge.toasts.length, 1, "the nudge shows once");
});

test("abandoning the sign-in never nudges", async (t) => {
  const nudge = await mountNudge(t);
  await nudge.settlePolicy();
  await nudge.rerender();

  assert.deepEqual(nudge.toasts, []);
  assert.notEqual(nudge.storage.getItem(PROMPTED_AT_KEY), null, "still waiting on a sign-in");
});

test("an ordinary launch by a signed-in user never nudges", async (t) => {
  const nudge = await mountNudge(t, { prompted: false });
  await nudge.signIn();
  await nudge.settlePolicy();

  assert.deepEqual(nudge.toasts, []);
});

test("dictation already on Cloud, or a policy that forbids it, gets no nudge", async (t) => {
  await t.test("already on Cloud", async (t) => {
    const nudge = await mountNudge(t, {
      settings: {
        transcriptionMode: "openwhispr",
        cloudTranscriptionMode: "openwhispr",
        cloudTranscriptionProvider: "openwhispr",
      },
    });
    await nudge.settlePolicy();
    await nudge.signIn();

    assert.deepEqual(nudge.toasts, []);
    assert.equal(nudge.storage.getItem(PROMPTED_AT_KEY), null);
  });

  await t.test("policy forbids Cloud", async (t) => {
    const nudge = await mountNudge(t);
    await nudge.signIn();
    await nudge.settlePolicy("managed", managedPolicy(["providers"], ["groq"]));

    assert.deepEqual(nudge.toasts, []);
    assert.equal(nudge.storage.getItem(PROMPTED_AT_KEY), null);
  });

  // The stored preference still reads "providers", but the policy clamps dictation onto
  // Cloud, which is where the settings pane shows it — so there is nothing to switch.
  await t.test("policy already puts dictation on Cloud", async (t) => {
    const nudge = await mountNudge(t);
    await nudge.signIn();
    await nudge.settlePolicy("managed", managedPolicy(["openwhispr"], []));

    assert.deepEqual(nudge.toasts, []);
    assert.equal(nudge.storage.getItem(PROMPTED_AT_KEY), null);
  });
});
