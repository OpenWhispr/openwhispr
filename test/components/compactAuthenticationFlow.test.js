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
  globalThis.__compactAuthTestState = { pendingEmail: null, signOutCount: 0 };
  t.after(() => {
    delete globalThis.__compactAuthTestState;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-compact-authentication-state-",
    noExternal: ["react"],
    mockModules: {
      react: `
        export function useState() {
          const state = globalThis.__compactAuthTestState;
          return [state.pendingEmail, (value) => { state.pendingEmail = value; }];
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

  const authStep = CompactAuthenticationFlow(props);
  assert.equal(authStep.type.name, "AuthenticationStep");
  assert.equal(authStep.props.onAuthComplete, props.onAuthComplete);
  assert.equal(authStep.props.onContinueWithoutAccount, props.onContinueWithoutAccount);

  authStep.props.onNeedsVerification("person@example.com");
  const verificationStep = CompactAuthenticationFlow(props);
  assert.equal(verificationStep.type.name, "EmailVerificationStep");
  assert.equal(verificationStep.props.email, "person@example.com");

  verificationStep.props.onBack();
  await Promise.resolve();
  assert.equal(globalThis.__compactAuthTestState.signOutCount, 1);
  assert.equal(CompactAuthenticationFlow(props).type.name, "AuthenticationStep");

  authStep.props.onNeedsVerification("person@example.com");
  CompactAuthenticationFlow(props).props.onVerified();
  assert.equal(authCompleteCount, 1);
  assert.equal(CompactAuthenticationFlow(props).type.name, "AuthenticationStep");
});
