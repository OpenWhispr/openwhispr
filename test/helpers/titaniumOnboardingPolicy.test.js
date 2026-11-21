const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/titanium/titaniumOnboardingPolicy.js");

test("Titanium cloud is enabled only with a portal and app slug", async () => {
  const { isTitaniumCloudEnabled } = await load();
  assert.equal(isTitaniumCloudEnabled({ portalUrl: "https://a.test", appSlug: "x" }), true);
  assert.equal(isTitaniumCloudEnabled({ portalUrl: "", appSlug: "x" }), false);
  assert.equal(isTitaniumCloudEnabled(undefined), false);
});

test("auth step: upstream when configured, Titanium when only Titanium, else unconfigured", async () => {
  const { resolveAuthStepMode, shouldOfferAuthStep } = await load();
  assert.equal(resolveAuthStepMode({ authConfigured: true, titaniumEnabled: true }), "upstream");
  assert.equal(resolveAuthStepMode({ authConfigured: false, titaniumEnabled: true }), "titanium");
  assert.equal(
    resolveAuthStepMode({ authConfigured: false, titaniumEnabled: false }),
    "unconfigured"
  );
  assert.equal(shouldOfferAuthStep({ cloudEnabled: false, titaniumEnabled: true }), true);
  assert.equal(shouldOfferAuthStep({ cloudEnabled: false, titaniumEnabled: false }), false);
});

test("needsReauth follows Titanium state when Titanium is the account system", async () => {
  const { resolveNeedsReauth } = await load();
  const base = {
    titaniumEnabled: true,
    cloudEnabled: false,
    titaniumLoaded: true,
    upstreamSignedIn: false,
    authSkipped: false,
  };
  assert.equal(resolveNeedsReauth({ ...base, titaniumSignedIn: false }), true);
  assert.equal(resolveNeedsReauth({ ...base, titaniumSignedIn: true }), false);
  assert.equal(
    resolveNeedsReauth({ ...base, titaniumSignedIn: false, titaniumLoaded: false }),
    false
  );
  assert.equal(resolveNeedsReauth({ ...base, titaniumSignedIn: false, authSkipped: true }), false);
});

test("needsReauth keeps the upstream session when hosted cloud is enabled or Titanium is off", async () => {
  const { resolveNeedsReauth } = await load();
  const base = { titaniumLoaded: true, titaniumSignedIn: true, authSkipped: false };
  assert.equal(
    resolveNeedsReauth({
      ...base,
      titaniumEnabled: true,
      cloudEnabled: true,
      upstreamSignedIn: false,
    }),
    true
  );
  assert.equal(
    resolveNeedsReauth({
      ...base,
      titaniumEnabled: false,
      cloudEnabled: false,
      upstreamSignedIn: true,
    }),
    false
  );
});

test("Titanium setup card needs Titanium enabled and policy approval", async () => {
  const { shouldOfferTitaniumSetup, resolveTitaniumSetupAction } = await load();
  assert.equal(shouldOfferTitaniumSetup({ titaniumEnabled: true }), true);
  assert.equal(
    shouldOfferTitaniumSetup({ titaniumEnabled: true, policyAllowsCloud: false }),
    false
  );
  assert.equal(shouldOfferTitaniumSetup({ titaniumEnabled: false }), false);
  assert.equal(resolveTitaniumSetupAction({ titaniumSignedIn: true }), "continue");
  assert.equal(resolveTitaniumSetupAction({ titaniumSignedIn: false }), "signIn");
});

test("STT notice: sign-in for our host while signed out, generic otherwise", async () => {
  const { resolveSttEndpointNotice } = await load();
  const ours = { refused: true, hasApiKey: false, isTitaniumEndpoint: true, titaniumEnabled: true };
  assert.equal(resolveSttEndpointNotice({ ...ours, titaniumSignedIn: false }), "titaniumSignIn");
  assert.equal(resolveSttEndpointNotice({ ...ours, titaniumSignedIn: true }), "unauthorized");
  assert.equal(
    resolveSttEndpointNotice({ ...ours, isTitaniumEndpoint: false, titaniumSignedIn: false }),
    "unauthorized"
  );
  assert.equal(
    resolveSttEndpointNotice({ ...ours, isTitaniumEndpoint: false, hasApiKey: true }),
    null
  );
  assert.equal(resolveSttEndpointNotice({ ...ours, refused: false }), null);
});

test("account session: Titanium decides without hosted cloud, upstream otherwise", async () => {
  const { resolveAccountSignedIn } = await load();
  const base = { titaniumSignedIn: true, upstreamSignedIn: false };
  assert.equal(
    resolveAccountSignedIn({ ...base, titaniumEnabled: true, cloudEnabled: false }),
    true
  );
  assert.equal(
    resolveAccountSignedIn({ ...base, titaniumEnabled: true, cloudEnabled: true }),
    false
  );
  assert.equal(
    resolveAccountSignedIn({ ...base, titaniumEnabled: false, cloudEnabled: false }),
    false
  );
  assert.equal(
    resolveAccountSignedIn({
      titaniumSignedIn: false,
      upstreamSignedIn: true,
      titaniumEnabled: false,
      cloudEnabled: true,
    }),
    true
  );
});

test("STT check is re-sent after the real sequence: signed out, 401 notice, sign-in", async () => {
  const { stepSttRetry, resolveSttEndpointNotice } = await load();
  const ours = { hasApiKey: false, isTitaniumEndpoint: true, titaniumEnabled: true };
  const noticeFor = (refused, titaniumSignedIn) =>
    resolveSttEndpointNotice({ ...ours, refused, titaniumSignedIn });
  let state = { signedIn: false, signedOutNotice: null };
  const render = (signedIn, notice) => {
    const step = stepSttRetry(state, { signedIn, notice });
    state = step.state;
    return step.retry;
  };

  assert.equal(render(false, noticeFor(false, false)), false); // checking
  assert.equal(render(false, noticeFor(true, false)), false); // 401 -> sign-in notice
  assert.equal(noticeFor(true, false), "titaniumSignIn");
  // Sign-in lands while the old refusal is still held: the notice has already moved on.
  assert.equal(noticeFor(true, true), "unauthorized");
  assert.equal(render(true, noticeFor(true, true)), true); // retry fires once
  assert.equal(render(true, noticeFor(false, true)), false); // fresh check passes, notice clears
  assert.equal(noticeFor(false, true), null);
});

test("STT retry does not fire without a prior sign-in notice or when already signed in", async () => {
  const { stepSttRetry } = await load();
  const unauthorized = { signedIn: false, signedOutNotice: "unauthorized" };
  assert.equal(stepSttRetry(unauthorized, { signedIn: true, notice: null }).retry, false);
  const already = { signedIn: true, signedOutNotice: null };
  assert.equal(stepSttRetry(already, { signedIn: true, notice: "unauthorized" }).retry, false);
});

test("STT notice: a signed-in account without a license gets the no-license notice, never an API key", async () => {
  const { resolveSttEndpointNotice } = await load();
  const signedIn = {
    refused: true,
    hasApiKey: false,
    isTitaniumEndpoint: true,
    titaniumEnabled: true,
    titaniumSignedIn: true,
  };
  const noLicense = { titaniumLicensed: false, titaniumLicenseReason: "no_license" };
  assert.equal(resolveSttEndpointNotice({ ...signedIn, ...noLicense }), "titaniumNoLicense");
  // signed out still asks to sign in first
  assert.equal(
    resolveSttEndpointNotice({ ...signedIn, ...noLicense, titaniumSignedIn: false }),
    "titaniumSignIn"
  );
  // a licensed user, or an unknown license, keeps the generic refusal
  assert.equal(
    resolveSttEndpointNotice({ ...signedIn, titaniumLicensed: true, titaniumLicenseReason: null }),
    "unauthorized"
  );
  assert.equal(resolveSttEndpointNotice(signedIn), "unauthorized");
  // not our host, or not refused: no license notice
  assert.equal(
    resolveSttEndpointNotice({ ...signedIn, ...noLicense, isTitaniumEndpoint: false }),
    "unauthorized"
  );
  assert.equal(resolveSttEndpointNotice({ ...signedIn, ...noLicense, refused: false }), null);
});

test("STT retry: the no-license notice does not trigger a sign-in retry", async () => {
  const { stepSttRetry } = await load();
  let step = stepSttRetry(
    { signedIn: false, signedOutNotice: null },
    { signedIn: true, notice: "titaniumNoLicense" }
  );
  assert.equal(step.retry, false);
  step = stepSttRetry(step.state, { signedIn: true, notice: "titaniumNoLicense" });
  assert.equal(step.retry, false);
});

const titaniumRoute = {
  mode: "self-hosted",
  useLocalWhisper: false,
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "custom",
  titaniumEnabled: true,
  destinationUrl: "https://stt.titaniumlabs.test/v1",
  forkConfig: { DEFAULT_STT: { baseUrl: "https://stt.titaniumlabs.test/v1" } },
};

test("engine tab: titanium only for an enabled, non-local custom route on our host", async () => {
  const { resolveTranscriptionEngineTab } = await load();
  assert.equal(resolveTranscriptionEngineTab(titaniumRoute), "titanium");
  const keep = (over) => resolveTranscriptionEngineTab({ ...titaniumRoute, ...over });
  assert.equal(keep({ titaniumEnabled: false }), "self-hosted");
  assert.equal(keep({ destinationUrl: "https://other.example.com/v1" }), "self-hosted");
  assert.equal(keep({ cloudTranscriptionProvider: "openai", mode: "providers" }), "providers");
  assert.equal(keep({ useLocalWhisper: true, mode: "local" }), "local");
  // a stale self-hosted URL that wins routing: the Titanium base URL is not the destination
  const { transcriptionDestinationUrl } = await import("../../src/helpers/transcriptionAuth.js");
  const stale = {
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://old.example.com/v1",
    cloudTranscriptionBaseUrl: "https://stt.titaniumlabs.test/v1",
  };
  assert.equal(keep({ destinationUrl: transcriptionDestinationUrl(stale) }), "self-hosted");
  assert.equal(keep({ cloudTranscriptionMode: "openwhispr", mode: "openwhispr" }), "openwhispr");
});

test("titaniumEngineSettings is the payload the setup card writes", async () => {
  const { titaniumEngineSettings } = await load();
  assert.deepEqual(titaniumEngineSettings({ baseUrl: "https://stt.test/v1", model: "scribe" }), {
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://stt.test/v1",
    cloudTranscriptionModel: "scribe",
  });
});

test("leaving the titanium tab clears the base URL only when it is ours", async () => {
  const { settingsOnLeavingTitaniumEngine } = await load();
  assert.deepEqual(settingsOnLeavingTitaniumEngine({ isTitaniumUrl: true }), {
    cloudTranscriptionBaseUrl: "",
  });
  assert.deepEqual(settingsOnLeavingTitaniumEngine({ isTitaniumUrl: false }), {});
});

test("titanium engine state: signedOut, noLicense or licensed", async () => {
  const { resolveTitaniumEngineState } = await load();
  assert.equal(
    resolveTitaniumEngineState({ signedIn: false, licensed: false, reason: "signed_out" }),
    "signedOut"
  );
  assert.equal(
    resolveTitaniumEngineState({ signedIn: true, licensed: false, reason: "no_license" }),
    "noLicense"
  );
  assert.equal(
    resolveTitaniumEngineState({ signedIn: true, licensed: true, reason: null }),
    "licensed"
  );
});

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("selecting EdgeAssistant cloud through the real store resolves the route to the Titanium URL", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-titanium-engine-test-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { resolveTranscriptionRoute } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");
  const { titaniumEngineSettings } = await load();
  const stt = { baseUrl: "https://stt.titaniumlabs.test/v1", model: "scribe" };
  const store = useSettingsStore.getState();
  store.setRemoteTranscriptionUrl("https://old.example.com/v1");
  store.setRemoteTranscriptionModel("old-model");
  store.setTranscriptionMode("self-hosted");
  store.setMeetingRemoteTranscriptionUrl("https://old.example.com/v1");
  store.setUploadRemoteTranscriptionUrl("https://old.example.com/v1");
  store.setUploadRemoteTranscriptionModel("old-model");
  store.setCloudTranscriptionForAllScopes(titaniumEngineSettings(stt));
  let after = useSettingsStore.getState();
  assert.equal(after.remoteTranscriptionUrl, "");
  assert.equal(after.remoteTranscriptionModel, "");
  assert.equal(after.meetingRemoteTranscriptionUrl, "");
  assert.equal(after.uploadRemoteTranscriptionUrl, "");
  assert.equal(after.uploadRemoteTranscriptionModel, "");
  const route = resolveTranscriptionRoute({ settings: after });
  assert.equal(route.provider, "custom");
  assert.ok(route.endpoint.startsWith(stt.baseUrl));

  // reselecting while already on the tab re-applies the clearing payload
  store.setRemoteTranscriptionUrl("https://again.example.com/v1");
  useSettingsStore.getState().setCloudTranscriptionForAllScopes(titaniumEngineSettings(stt));
  after = useSettingsStore.getState();
  assert.equal(after.remoteTranscriptionUrl, "");
  assert.ok(resolveTranscriptionRoute({ settings: after }).endpoint.startsWith(stt.baseUrl));
});
