const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const AUTH_MODE_INDEX = 0;
const EMAIL_INDEX = 1;
const PASSWORD_INDEX = 2;
const FULL_NAME_INDEX = 3;
const SSO_DISCOVERY_INDEX = 8;
const ERROR_INDEX = 9;

function createHarness(values = {}) {
  return {
    cursor: 0,
    refCursor: 0,
    values,
    refs: {},
    discoveryCalls: [],
    discoveryResult: { exists: false },
    discoveryError: null,
    signupResult: {},
  };
}

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

async function settleAsyncHandler() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("email authentication discovers accounts before choosing sign-in or sign-up", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-authentication-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      react: `
        export default {};
        export function useState(initialValue) {
          const harness = globalThis.__authenticationStepHarness;
          const index = harness.cursor++;
          if (!(index in harness.values)) {
            harness.values[index] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.values[index], (nextValue) => {
            harness.values[index] = typeof nextValue === "function"
              ? nextValue(harness.values[index])
              : nextValue;
          }];
        }
        export function useCallback(callback) { return callback; }
        export function useEffect() {}
        export function useRef(initialValue) {
          const harness = globalThis.__authenticationStepHarness;
          const index = harness.refCursor++;
          if (!(index in harness.refs)) harness.refs[index] = { current: initialValue };
          return harness.refs[index];
        }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "/hooks/useAuth": `
        export function useAuth() {
          return { isLoaded: true, isSignedIn: false, user: null };
        }
      `,
      "/lib/auth": `
        export const AUTH_URL = "https://auth.example.test";
        export const authClient = {
          signUp: {
            async email(payload) {
              const harness = globalThis.__authenticationStepHarness;
              harness.signupPayload = payload;
              return harness.signupResult;
            },
          },
          signIn: { async email() { return {}; } },
        };
        export async function signInWithSocial() { return {}; }
        export async function signInWithSSO() { return {}; }
        export function updateLastSignInTime() {}
      `,
      "/lib/emailAuthDiscovery": `
        export async function discoverEmailAuth(email, authUrl) {
          const harness = globalThis.__authenticationStepHarness;
          harness.discoveryCalls.push({ email, authUrl });
          if (harness.discoveryError) throw harness.discoveryError;
          return harness.discoveryResult;
        }
      `,
      "/utils/logger": `export default { error() {} };`,
      "/utils/platform": `export function getCachedPlatform() { return "linux"; }`,
      "/ForgotPasswordView": `export default function ForgotPasswordView() { return null; }`,
      "/OnboardingShell": `
        export function CompactOnboardingFrame(props) { return props.children; }
      `,
      "/ui/button": `export function Button() { return null; }`,
      "/ui/input": `export function Input() { return null; }`,
      "lucide-react": `
        const Icon = () => null;
        export { Icon as AlertCircle, Icon as ArrowRight, Icon as Building2, Icon as Check,
          Icon as Loader2, Icon as ChevronLeft };
      `,
    },
  });
  const { default: AuthenticationStep } = await vite.ssrLoadModule(
    "/components/AuthenticationStep.tsx"
  );
  const props = { onAuthComplete() {}, onNeedsVerification() {} };

  const render = (harness) => {
    globalThis.__authenticationStepHarness = harness;
    harness.cursor = 0;
    harness.refCursor = 0;
    return AuthenticationStep(props);
  };
  const submitEmail = async (harness) => {
    const form = findElement(render(harness), (node) => node.type === "form");
    assert.ok(form, "email form should render");
    form.props.onSubmit({ preventDefault() {} });
    await settleAsyncHandler();
  };

  const existingAccount = createHarness({ [EMAIL_INDEX]: "returning@example.com" });
  existingAccount.discoveryResult = { exists: true };
  await submitEmail(existingAccount);
  assert.equal(existingAccount.values[AUTH_MODE_INDEX], "sign-in");
  assert.deepEqual(existingAccount.discoveryCalls, [
    { email: "returning@example.com", authUrl: "https://auth.example.test" },
  ]);

  const newAccount = createHarness({ [EMAIL_INDEX]: "new@example.com" });
  await submitEmail(newAccount);
  assert.equal(newAccount.values[AUTH_MODE_INDEX], "sign-up");

  const missingEndpoint = createHarness({ [EMAIL_INDEX]: "user@selfhosted.example" });
  missingEndpoint.discoveryResult = null;
  await submitEmail(missingEndpoint);
  assert.equal(missingEndpoint.values[AUTH_MODE_INDEX], "sign-up");
  assert.equal(missingEndpoint.values[ERROR_INDEX], null);

  const unavailableDiscovery = createHarness({ [EMAIL_INDEX]: "user@example.com" });
  unavailableDiscovery.discoveryError = new Error("offline");
  await submitEmail(unavailableDiscovery);
  assert.equal(unavailableDiscovery.values[AUTH_MODE_INDEX], null);
  assert.equal(unavailableDiscovery.values[ERROR_INDEX], "auth.errors.failedUserCheck");

  const ssoAccount = createHarness({ [EMAIL_INDEX]: "user@example.com" });
  ssoAccount.discoveryResult = {
    exists: true,
    sso: { available: true, required: false, domain: "example.com" },
  };
  await submitEmail(ssoAccount);
  assert.equal(ssoAccount.values[AUTH_MODE_INDEX], null);
  assert.deepEqual(ssoAccount.values[SSO_DISCOVERY_INDEX], {
    exists: true,
    required: false,
    domain: "example.com",
  });

  const duplicateRace = createHarness({
    [AUTH_MODE_INDEX]: "sign-up",
    [EMAIL_INDEX]: "returning@example.com",
    [PASSWORD_INDEX]: "password123",
    [FULL_NAME_INDEX]: "Returning User",
  });
  duplicateRace.signupResult = {
    error: {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "A localized duplicate-account response",
    },
  };
  const signupForm = findElement(render(duplicateRace), (node) => node.type === "form");
  assert.ok(signupForm, "sign-up form should render");
  await signupForm.props.onSubmit({ preventDefault() {} });
  assert.equal(duplicateRace.values[AUTH_MODE_INDEX], "sign-in");
  assert.equal(duplicateRace.values[PASSWORD_INDEX], "");
  assert.equal(duplicateRace.values[ERROR_INDEX], "auth.errors.accountExistsSignIn");
});
