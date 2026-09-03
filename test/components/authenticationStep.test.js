const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const EMPTY_AUTH_DRAFT = {
  authMode: null,
  email: "",
  fullName: "",
  ssoDiscovery: null,
  pendingVerificationEmail: null,
};

function createHarness() {
  return {
    cursor: 0,
    refCursor: 0,
    values: {},
    refs: {},
    effects: [],
    cleanups: [],
    debouncedCalls: 0,
    pendingDebounced: null,
    discoveryCalls: [],
    ssoCalls: [],
    discoveryResult: { exists: false },
    discoveryError: null,
    signupResult: {},
    ssoResult: {},
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

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return textContent(node.props?.children);
}

const isInput = (node) => node.type?.name === "Input";
const inputByPlaceholder = (tree, placeholder) =>
  findElement(tree, (node) => isInput(node) && node.props?.placeholder === placeholder);
// Sign-in shows the address back instead of asking for a name, so a read-only
// field is how "this is the password step for a known account" reads.
const readOnlyEmailField = (tree) =>
  findElement(tree, (node) => isInput(node) && node.props?.readOnly === true);
const passwordField = (tree) =>
  findElement(tree, (node) => isInput(node) && node.props?.type === "password");
const providerTile = (tree, label) =>
  findElement(
    tree,
    (node) =>
      node.type?.name === "ProviderTile" && (label === undefined || node.props?.label === label)
  );
const buttonLabelled = (tree, label) =>
  findElement(tree, (node) => node.type?.name === "Button" && textContent(node) === label);

async function settleAsyncHandler() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("email authentication discovers accounts, restores drafts, and persists them once per pause", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  t.after(() => {
    delete globalThis.__authenticationStepHarness;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-authentication-step-",
    noExternal: ["react", "react-i18next", "lucide-react"],
    mockModules: {
      // A minimal renderer rather than react-dom: it returns the element tree so
      // the assertions can read rendered output, and it collects effects so the
      // render helper can run them. Nothing here is keyed on hook call order.
      react: `
        export default {};
        export function useState(initialValue) {
          const harness = globalThis.__authenticationStepHarness;
          const slot = harness.cursor++;
          if (!(slot in harness.values)) {
            harness.values[slot] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [harness.values[slot], (nextValue) => {
            harness.values[slot] = typeof nextValue === "function"
              ? nextValue(harness.values[slot])
              : nextValue;
          }];
        }
        export function useCallback(callback) { return callback; }
        export function useEffect(effect) {
          globalThis.__authenticationStepHarness.effects.push(effect);
        }
        export function useRef(initialValue) {
          const harness = globalThis.__authenticationStepHarness;
          const slot = harness.refCursor++;
          if (!(slot in harness.refs)) harness.refs[slot] = { current: initialValue };
          return harness.refs[slot];
        }
      `,
      "/jsx-dev-runtime": `
        export const Fragment = Symbol.for("react.fragment");
        export function jsxDEV(type, props, key) { return { type, props, key }; }
      `,
      "react-i18next": `
        export function useTranslation() {
          return { t(key, options) { return options ? key + ":" + JSON.stringify(options) : key; } };
        }
      `,
      // Records the pending write instead of firing it, so the test can tell a
      // scheduled draft apart from a persisted one.
      "/hooks/useDebouncedCallback": `
        export function useDebouncedCallback(callback) {
          const harness = globalThis.__authenticationStepHarness;
          harness.pendingDebounced = callback;
          return () => { harness.debouncedCalls += 1; };
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
        export async function signInWithSSO(email) {
          const harness = globalThis.__authenticationStepHarness;
          harness.ssoCalls.push(email);
          return harness.ssoResult;
        }
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

  const render = (harness, overrides = {}) => {
    globalThis.__authenticationStepHarness = harness;
    harness.cursor = 0;
    harness.refCursor = 0;
    harness.effects = [];
    const tree = AuthenticationStep({ ...props, ...overrides });
    // Running the collected effects is what makes the draft ref, the scheduled
    // write and the unmount flush observable.
    harness.cleanups = harness.effects
      .map((effect) => effect())
      .filter((cleanup) => typeof cleanup === "function");
    return tree;
  };
  const typeEmail = (harness, address, overrides) => {
    const tree = render(harness, overrides);
    const field = inputByPlaceholder(tree, "auth.emailStep.emailPlaceholder");
    assert.ok(field, "the welcome view should offer an email field");
    field.props.onChange({ target: { value: address } });
    return tree;
  };
  const submitEmail = async (harness, address, overrides) => {
    typeEmail(harness, address, overrides);
    const form = findElement(render(harness, overrides), (node) => node.type === "form");
    assert.ok(form, "email form should render");
    form.props.onSubmit({ preventDefault() {} });
    await settleAsyncHandler();
    return render(harness, overrides);
  };

  const existingAccount = createHarness();
  existingAccount.discoveryResult = { exists: true };
  const signIn = await submitEmail(existingAccount, "returning@example.com");
  assert.equal(readOnlyEmailField(signIn)?.props.value, "returning@example.com");
  assert.ok(passwordField(signIn), "a known account goes straight to the password step");
  assert.match(textContent(signIn), /auth\.passwordForm\.signIn/);
  assert.match(textContent(signIn), /auth\.passwordForm\.forgotPassword/);
  assert.deepEqual(existingAccount.discoveryCalls, [
    { email: "returning@example.com", authUrl: "https://auth.example.test" },
  ]);

  const newAccount = createHarness();
  const signUp = await submitEmail(newAccount, "new@example.com");
  assert.ok(
    inputByPlaceholder(signUp, "auth.passwordForm.fullNamePlaceholder"),
    "an unknown address asks for a name"
  );
  assert.match(textContent(signUp), /auth\.passwordForm\.createAccountButton/);

  // A self-hosted deployment without the discovery endpoint still gets sign-up,
  // and no error for the missing endpoint.
  const missingEndpoint = createHarness();
  missingEndpoint.discoveryResult = null;
  const selfHosted = await submitEmail(missingEndpoint, "user@selfhosted.example");
  assert.ok(inputByPlaceholder(selfHosted, "auth.passwordForm.fullNamePlaceholder"));
  assert.doesNotMatch(textContent(selfHosted), /auth\.errors\./);

  const unavailableDiscovery = createHarness();
  unavailableDiscovery.discoveryError = new Error("offline");
  const offline = await submitEmail(unavailableDiscovery, "user@example.com");
  assert.ok(providerTile(offline), "an unreachable check must not advance the flow");
  assert.match(textContent(offline), /auth\.errors\.failedUserCheck/);

  const ssoAccount = createHarness();
  ssoAccount.discoveryResult = {
    exists: true,
    sso: { available: true, required: false, domain: "example.com" },
  };
  const company = await submitEmail(ssoAccount, "user@example.com");
  assert.match(textContent(company), /auth\.sso\.companySignInTitle/);
  assert.match(textContent(company), /auth\.sso\.availableDescription:\{"domain":"example\.com"\}/);
  const useEmailInstead = buttonLabelled(company, "auth.sso.useEmailInstead");
  assert.ok(useEmailInstead, "an optional SSO domain keeps the password route open");
  useEmailInstead.props.onClick();
  assert.ok(
    readOnlyEmailField(render(ssoAccount)),
    "leaving SSO for an existing account lands on sign-in"
  );

  const directSso = createHarness();
  const ssoTile = providerTile(typeEmail(directSso, "person@company.test"), "SSO");
  assert.ok(ssoTile, "SSO provider tile should render");
  ssoTile.props.onClick();
  const ssoScreen = render(directSso);
  assert.match(textContent(ssoScreen), /auth\.sso\.workEmailLabel/);
  const ssoForm = findElement(ssoScreen, (node) => node.type === "form");
  assert.ok(ssoForm, "SSO work-email form should render after choosing SSO");
  ssoForm.props.onSubmit({ preventDefault() {} });
  await settleAsyncHandler();
  assert.deepEqual(directSso.ssoCalls, ["person@company.test"]);

  // A resumed draft restores the identity fields only. The SSO work-email screen
  // is transient, so a returning user lands back on the provider choices.
  const resumedWelcome = createHarness();
  const resumedTree = render(resumedWelcome, {
    resumeState: { ...EMPTY_AUTH_DRAFT, email: "resume@company.test", fullName: "Resume User" },
  });
  assert.equal(
    inputByPlaceholder(resumedTree, "auth.emailStep.emailPlaceholder").props.value,
    "resume@company.test"
  );
  assert.ok(
    providerTile(resumedTree),
    "a resumed draft should reopen the provider choices, not the SSO email step"
  );

  const resumedSignUp = createHarness();
  const resumedSignUpTree = render(resumedSignUp, {
    resumeState: {
      ...EMPTY_AUTH_DRAFT,
      authMode: "sign-up",
      email: "resume@company.test",
      fullName: "Resume User",
    },
  });
  assert.equal(
    inputByPlaceholder(resumedSignUpTree, "auth.passwordForm.fullNamePlaceholder").props.value,
    "Resume User"
  );

  const duplicateRace = createHarness();
  const raceSignUp = await submitEmail(duplicateRace, "returning@example.com");
  inputByPlaceholder(raceSignUp, "auth.passwordForm.fullNamePlaceholder").props.onChange({
    target: { value: "Returning User" },
  });
  passwordField(render(duplicateRace)).props.onChange({ target: { value: "password123" } });
  duplicateRace.signupResult = {
    error: {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "A localized duplicate-account response",
    },
  };
  const signupForm = findElement(render(duplicateRace), (node) => node.type === "form");
  assert.ok(signupForm, "sign-up form should render");
  await signupForm.props.onSubmit({ preventDefault() {} });
  const afterRace = render(duplicateRace);
  assert.ok(readOnlyEmailField(afterRace), "a duplicate account switches to sign-in");
  assert.equal(passwordField(afterRace).props.value, "", "the password is cleared for the retry");
  assert.match(textContent(afterRace), /auth\.errors\.accountExistsSignIn/);

  // The resume draft is written once per typing pause, never per keystroke, and
  // carries only the fields this step owns.
  const drafting = createHarness();
  const draftWrites = [];
  const draftProps = {
    resumeState: EMPTY_AUTH_DRAFT,
    onResumeStateChange: (patch) => draftWrites.push(patch),
  };
  typeEmail(drafting, "typed@example.com", draftProps);
  render(drafting, draftProps);
  assert.deepEqual(draftWrites, [], "typing must not persist per keystroke");
  assert.ok(drafting.debouncedCalls >= 2, "every change schedules the debounced write");
  drafting.pendingDebounced();
  assert.deepEqual(draftWrites, [
    { authMode: null, email: "typed@example.com", fullName: "", ssoDiscovery: null },
  ]);

  // Sign-up unmounts this step on its way to verification, so the flush has to
  // cover the write the debounce still had pending.
  const abandoned = createHarness();
  const flushedWrites = [];
  const flushProps = {
    resumeState: EMPTY_AUTH_DRAFT,
    onResumeStateChange: (patch) => flushedWrites.push(patch),
  };
  typeEmail(abandoned, "gone@example.com", flushProps);
  render(abandoned, flushProps);
  assert.deepEqual(flushedWrites, []);
  assert.ok(abandoned.cleanups.length > 0, "the flush effect should register a cleanup");
  abandoned.cleanups.forEach((cleanup) => cleanup());
  assert.deepEqual(flushedWrites, [
    { authMode: null, email: "gone@example.com", fullName: "", ssoDiscovery: null },
  ]);
});
