const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

test("returning-user authentication renders the complete compact onboarding surface", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => "linux" } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-compact-reauthentication-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "onboarding-hero-dither.webp": `export default "hero-light.webp";`,
      "onboarding-hero-dither-dark.webp": `export default "hero-dark.webp";`,
      "onboarding-bg-light.svg": `export default "background-light.svg";`,
      "onboarding-bg-dark.svg": `export default "background-dark.svg";`,
      "/config/constants": `export const OPENWHISPR_API_URL = "";`,
      "/hooks/useAuth": `
        export function useAuth() {
          return { isLoaded: true, isSignedIn: false, user: null };
        }
      `,
      "/lib/auth": `
        export const AUTH_URL = "https://auth.openwhispr.test";
        export const authClient = {};
        export async function signInWithSocial() { return {}; }
        export async function signInWithSSO() { return {}; }
        export async function signOut() {}
        export function updateLastSignInTime() {}
      `,
      "/utils/logger": `export default { error() {} };`,
      "/utils/platform": `
        export function getPlatform() { return "linux"; }
        export function getCachedPlatform() { return "linux"; }
      `,
    },
  });
  const { default: ReauthenticationScreen } = await vite.ssrLoadModule(
    "/components/ReauthenticationScreen.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(ReauthenticationScreen, {
      onAuthComplete: noop,
      onContinueWithoutAccount: noop,
    })
  );

  assert.match(markup, /<main class="onboarding-canvas[^"]*compact/);
  assert.match(markup, /onboarding-compact-hero/);
  assert.match(markup, /auth\.welcomeTitle/);
  assert.match(markup, /auth\.emailStep\.continueWithoutAccount/);
  assert.match(markup, /auth\.legal\.terms/);
  assert.match(markup, /auth\.legal\.privacy/);
  assert.doesNotMatch(markup, /onboarding-embedded-auth/);
});

test("verification success completes auth and backing out signs out before returning", async (t) => {
  globalThis.__compactAuthTestState = { cursor: 0, slots: {}, signOutCount: 0 };
  t.after(() => {
    delete globalThis.__compactAuthTestState;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-compact-authentication-state-",
    noExternal: ["react"],
    mockModules: {
      react: `
        export function useState(initialValue) {
          const state = globalThis.__compactAuthTestState;
          const index = state.cursor++;
          if (!(index in state.slots)) {
            state.slots[index] =
              typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [state.slots[index], (value) => {
            state.slots[index] = typeof value === "function" ? value(state.slots[index]) : value;
          }];
        }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "/AuthenticationStep": `
        export default function AuthenticationStep() { return null; }
      `,
      "/EmailVerificationStep": `
        export default function EmailVerificationStep() { return null; }
      `,
      "/lib/auth": `
        export async function signOut() {
          globalThis.__compactAuthTestState.signOutCount += 1;
        }
      `,
    },
  });
  const { CompactAuthenticationFlow } = await vite.ssrLoadModule(
    "/components/CompactAuthenticationFlow.tsx"
  );
  let authCompleteCount = 0;
  const props = {
    onAuthComplete: () => {
      authCompleteCount += 1;
    },
    onContinueWithoutAccount: noop,
  };
  const render = () => {
    globalThis.__compactAuthTestState.cursor = 0;
    return CompactAuthenticationFlow(props);
  };

  const authStep = render();
  assert.equal(authStep.type.name, "AuthenticationStep");
  assert.equal(authStep.props.onAuthComplete, props.onAuthComplete);
  assert.equal(authStep.props.onContinueWithoutAccount, props.onContinueWithoutAccount);

  authStep.props.onNeedsVerification("person@example.com");
  const verificationStep = render();
  assert.equal(verificationStep.type.name, "EmailVerificationStep");
  assert.equal(verificationStep.props.email, "person@example.com");

  verificationStep.props.onBack();
  await Promise.resolve();
  assert.equal(globalThis.__compactAuthTestState.signOutCount, 1);
  assert.equal(render().type.name, "AuthenticationStep");

  authStep.props.onNeedsVerification("person@example.com");
  render().props.onVerified();
  assert.equal(authCompleteCount, 1);
  assert.equal(render().type.name, "AuthenticationStep");
});

test("a restored verification screen offers its recovery actions immediately", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-email-verification-resumed-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "/config/constants": `export const OPENWHISPR_API_URL = "";`,
      "/lib/auth": `export const authClient = { getSession: async () => ({}) };`,
      "/onboarding/OnboardingShell": `
        export function CompactOnboardingFrame({ children }) { return children; }
      `,
    },
  });
  const { default: EmailVerificationStep } = await vite.ssrLoadModule(
    "/components/EmailVerificationStep.tsx"
  );
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(EmailVerificationStep, {
        email: "person@example.com",
        onVerified: noop,
        onBack: noop,
        ...props,
      })
    );

  // Signing up sends the mail this mount is waiting on, so the resend stays rate
  // limited and the row is held back while it is guaranteed to be useless.
  const justSent = render();
  assert.doesNotMatch(justSent, /emailVerification\.backToSignIn/);

  // A relaunch sends nothing. Holding the row back there strands the user with no
  // resend, no way back to sign-in and no shell footer until the timer expires.
  const restored = render({ resumed: true });
  assert.match(restored, /emailVerification\.backToSignIn/);
  assert.match(restored, /emailVerification\.resendButton/);
});

test("only an address restored from a saved session opens verification as resumed", async (t) => {
  globalThis.__compactAuthResumeState = { cursor: 0, values: {}, drafts: [] };
  t.after(() => {
    delete globalThis.__compactAuthResumeState;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-compact-authentication-resume-",
    noExternal: ["react"],
    mockModules: {
      react: `
        export function useState(initialValue) {
          const harness = globalThis.__compactAuthResumeState;
          const index = harness.cursor++;
          if (!(index in harness.values)) {
            harness.values[index] =
              typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.values[index], (nextValue) => {
            harness.values[index] =
              typeof nextValue === "function" ? nextValue(harness.values[index]) : nextValue;
          }];
        }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "/AuthenticationStep": `export default function AuthenticationStep() { return null; }`,
      "/EmailVerificationStep": `export default function EmailVerificationStep() { return null; }`,
      "/lib/auth": `export async function signOut() {}`,
    },
  });
  const { CompactAuthenticationFlow } = await vite.ssrLoadModule(
    "/components/CompactAuthenticationFlow.tsx"
  );
  const harness = globalThis.__compactAuthResumeState;
  const renderFlow = (props) => {
    harness.cursor = 0;
    return CompactAuthenticationFlow({
      onAuthComplete: noop,
      onContinueWithoutAccount: noop,
      onResumeStateChange: (patch) => harness.drafts.push(patch),
      ...props,
    });
  };

  const restored = renderFlow({ resumeState: { pendingVerificationEmail: "person@example.com" } });
  assert.equal(restored.type.name, "EmailVerificationStep");
  assert.equal(restored.props.email, "person@example.com");
  assert.equal(restored.props.resumed, true);

  // Backing out and signing up again does send a fresh mail, so the cooldown has
  // to come back. Continues from the restored state above on purpose: rebuilding
  // the harness here would re-seed the flag and prove nothing.
  restored.props.onBack();
  await new Promise((resolve) => setImmediate(resolve));
  const afterBack = renderFlow({ resumeState: { pendingVerificationEmail: "person@example.com" } });
  assert.equal(afterBack.type.name, "AuthenticationStep");
  // The button says "Back to sign in", and the draft still holds the sign-up mode
  // that opened verification — leaving it there reopens the create-account form for
  // the address just registered, which only fails with USER_ALREADY_EXISTS.
  assert.deepEqual(harness.drafts, [{ pendingVerificationEmail: null, authMode: "sign-in" }]);

  afterBack.props.onNeedsVerification("other@example.com");
  const resent = renderFlow({ resumeState: { pendingVerificationEmail: "person@example.com" } });
  assert.equal(resent.type.name, "EmailVerificationStep");
  assert.equal(resent.props.email, "other@example.com");
  assert.equal(resent.props.resumed, false);
  // The address has to reach the session, or the next launch cannot restore it.
  assert.deepEqual(harness.drafts.at(-1), { pendingVerificationEmail: "other@example.com" });
});
