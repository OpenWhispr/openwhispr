const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Every signed-out "sign in" entry point used to restart onboarding (#2128). The prompt
// signs the guest in where they are; afterwards it only suggests Cloud, because a
// post-sign-in cloud switch is what overrode Local for #2086.

const PROMPTED_AT_KEY = "signInPromptedAt";
const GUEST_ON_OWN_SETUP = {
  onboardingCompleted: "true",
  authenticationSkipped: "true",
  skipAuth: "true",
  transcriptionMode: "providers",
  useLocalWhisper: "false",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "groq",
};

async function mountSignInPrompt(t, { settings = {} } = {}) {
  let unmount = async () => {};
  t.after(() => unmount());
  let reloads = 0;
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { ...GUEST_ON_OWN_SETUP, ...settings },
    window: {
      location: {
        reload() {
          reloads += 1;
        },
      },
    },
  });
  const container = installHookDom(t);
  const toasts = [];
  const dismissed = [];
  globalThis.__signInPromptToasts = { toasts, dismissed };
  t.after(() => delete globalThis.__signInPromptToasts);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-sign-in-prompt-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/SignInDialog": `export default function SignInDialog() { return null; }`,
      "/ui/useToast": `
        function toast(props) {
          const { toasts } = globalThis.__signInPromptToasts;
          toasts.push(props);
          return "toast-" + toasts.length;
        }
        function dismiss(id) { globalThis.__signInPromptToasts.dismissed.push(id); }
        export function useToast() { return { toast, dismiss }; }
      `,
    },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { requestSignIn } = await vite.ssrLoadModule("/stores/signInPromptStore.ts");
  const { default: SignInPrompt } = await vite.ssrLoadModule("/components/SignInPrompt.tsx");

  let isSignedIn = false;
  let dialog;
  let settingsOpened = 0;
  const onOpenTranscriptionSettings = () => {
    settingsOpened += 1;
  };
  function Harness() {
    dialog = SignInPrompt({ isSignedIn, onOpenTranscriptionSettings });
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
    reloads: () => reloads,
    settingsOpened: () => settingsOpened,
    dialogOpen: () => dialog.props.open,
    requestSignIn: () => React.act(async () => requestSignIn()),
    closeDialog: () => React.act(async () => dialog.props.onOpenChange(false)),
    signIn: async () => {
      isSignedIn = true;
      await render();
    },
    settlePolicy: (status = "unmanaged", policy = null) =>
      React.act(async () => usePolicyStore.setState({ status, policy, appVersion: "1.10.0" })),
  };
}

test("signing in opens the dialog in place and leaves onboarding and routing alone", async (t) => {
  const prompt = await mountSignInPrompt(t, {
    settings: { transcriptionMode: "local", useLocalWhisper: "true" },
  });
  assert.equal(prompt.dialogOpen(), false);

  await prompt.requestSignIn();

  assert.equal(prompt.dialogOpen(), true);
  assert.equal(prompt.reloads(), 0);
  assert.equal(prompt.storage.getItem("onboardingCompleted"), "true");
  assert.equal(prompt.storage.getItem("onboardingSessionV2"), null);
  assert.equal(prompt.storage.getItem("onboardingCurrentStep"), null);
  assert.equal(prompt.storage.getItem("authenticationSkipped"), "true");
  assert.equal(prompt.storage.getItem("pendingCloudMigration"), null);
  assert.equal(prompt.storage.getItem("transcriptionMode"), "local");
  assert.equal(prompt.storage.getItem("useLocalWhisper"), "true");
  assert.deepEqual(prompt.toasts, []);
});

test("closing the dialog without signing in never nudges", async (t) => {
  const prompt = await mountSignInPrompt(t);
  await prompt.settlePolicy("idle");
  await prompt.requestSignIn();
  await prompt.closeDialog();

  assert.equal(prompt.dialogOpen(), false);
  assert.deepEqual(prompt.toasts, []);
});

test("an in-place sign-in nudges towards Cloud once the dialog closes", async (t) => {
  const prompt = await mountSignInPrompt(t);
  await prompt.requestSignIn();
  await prompt.signIn();
  await prompt.settlePolicy();
  assert.deepEqual(prompt.toasts, [], "no toast behind the open dialog");

  await prompt.closeDialog();

  assert.equal(prompt.toasts.length, 1);
  assert.equal(prompt.toasts[0].title, "controlPanel.cloudNudge.title");
  assert.equal(prompt.toasts[0].description, "controlPanel.cloudNudge.description");
  assert.equal(prompt.storage.getItem(PROMPTED_AT_KEY), null);
  assert.equal(prompt.storage.getItem("transcriptionMode"), "providers");
  assert.equal(prompt.storage.getItem("cloudTranscriptionMode"), "byok");

  prompt.toasts[0].action.props.onClick();
  assert.deepEqual(prompt.dismissed, ["toast-1"]);
  assert.equal(prompt.settingsOpened(), 1);

  await prompt.signIn();
  assert.equal(prompt.toasts.length, 1, "the nudge shows once");
});

test("a sign-in that reloaded the panel nudges after the account's policy settles", async (t) => {
  const prompt = await mountSignInPrompt(t, {
    settings: { [PROMPTED_AT_KEY]: String(Date.now()) },
  });
  await prompt.settlePolicy("loading");
  await prompt.signIn();
  assert.deepEqual(prompt.toasts, []);
  assert.notEqual(prompt.storage.getItem(PROMPTED_AT_KEY), null);

  await prompt.settlePolicy();

  assert.equal(prompt.toasts.length, 1);
  assert.equal(prompt.storage.getItem(PROMPTED_AT_KEY), null);
});

test("dictation already on Cloud, or a policy that forbids it, gets no nudge", async (t) => {
  await t.test("already on Cloud", async (t) => {
    const prompt = await mountSignInPrompt(t, {
      settings: {
        transcriptionMode: "openwhispr",
        cloudTranscriptionMode: "openwhispr",
        cloudTranscriptionProvider: "openwhispr",
        [PROMPTED_AT_KEY]: String(Date.now()),
      },
    });
    await prompt.settlePolicy();
    await prompt.signIn();

    assert.deepEqual(prompt.toasts, []);
    assert.equal(prompt.storage.getItem(PROMPTED_AT_KEY), null);
  });

  await t.test("policy forbids Cloud", async (t) => {
    const prompt = await mountSignInPrompt(t, {
      settings: { [PROMPTED_AT_KEY]: String(Date.now()) },
    });
    await prompt.signIn();
    await prompt.settlePolicy("managed", {
      version: 1,
      transcription: {
        allowedModes: ["providers"],
        allowedByokProviders: ["groq"],
        allowedEnterpriseProviders: [],
      },
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

    assert.deepEqual(prompt.toasts, []);
    assert.equal(prompt.storage.getItem(PROMPTED_AT_KEY), null);
  });
});
