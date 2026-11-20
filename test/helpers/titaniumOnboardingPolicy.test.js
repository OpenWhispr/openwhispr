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

test("STT check is re-sent when Titanium signs in over the sign-in notice", async () => {
  const { shouldRetrySttCheck } = await load();
  const notice = "titaniumSignIn";
  assert.equal(shouldRetrySttCheck({ wasSignedIn: false, signedIn: true, notice }), true);
  assert.equal(shouldRetrySttCheck({ wasSignedIn: true, signedIn: true, notice }), false);
  assert.equal(shouldRetrySttCheck({ wasSignedIn: false, signedIn: false, notice }), false);
  assert.equal(
    shouldRetrySttCheck({ wasSignedIn: false, signedIn: true, notice: "unauthorized" }),
    false
  );
});
