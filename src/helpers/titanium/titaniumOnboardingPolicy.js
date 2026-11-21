// ESM, pure (no electron, no React): decides which Titanium sign-in surfaces the
// renderer shows. The components stay thin adapters over these functions.

/** True when the fork build carries a Titanium portal to sign in to. */
export function isTitaniumCloudEnabled(titaniumConfig) {
  return Boolean(titaniumConfig?.portalUrl && titaniumConfig?.appSlug);
}

/**
 * Which UI the onboarding auth step renders.
 * - "upstream": the OpenWhispr email/social flow (hosted auth is configured).
 * - "titanium": "Sign in with Titanium" (no hosted auth, Titanium is enabled).
 * - "unconfigured": neither backend exists, so the not-configured notice shows.
 */
export function resolveAuthStepMode({ authConfigured, titaniumEnabled }) {
  if (authConfigured) return "upstream";
  return titaniumEnabled ? "titanium" : "unconfigured";
}

/** Whether onboarding may show the auth step instead of forcing the guest path. */
export function shouldOfferAuthStep({ cloudEnabled, titaniumEnabled }) {
  return Boolean(cloudEnabled || titaniumEnabled);
}

/**
 * Whether the user holds a valid account session. Titanium decides when it is the
 * account system (no hosted cloud); otherwise the upstream session does.
 */
export function resolveAccountSignedIn({
  titaniumEnabled,
  cloudEnabled,
  titaniumSignedIn,
  upstreamSignedIn,
}) {
  return titaniumEnabled && !cloudEnabled ? Boolean(titaniumSignedIn) : Boolean(upstreamSignedIn);
}

/**
 * Whether the control panel must show the reauthentication screen. With Titanium
 * as the account system its state decides; the upstream session is not consulted.
 * `titaniumLoaded` stops a not-yet-hydrated (signed-out looking) state from
 * flashing the screen at a user who is signed in.
 */
export function resolveNeedsReauth({
  titaniumEnabled,
  cloudEnabled,
  titaniumSignedIn,
  titaniumLoaded,
  upstreamSignedIn,
  authSkipped,
}) {
  if (authSkipped) return false;
  if (titaniumEnabled && !cloudEnabled) return titaniumLoaded && !titaniumSignedIn;
  return !upstreamSignedIn;
}

/** The "EdgeAssistant cloud (Titanium)" setup card is offered only with Titanium enabled. */
export function shouldOfferTitaniumSetup({ titaniumEnabled, policyAllowsCloud = true }) {
  return Boolean(titaniumEnabled && policyAllowsCloud);
}

/** Primary action of the Titanium setup card. */
export function resolveTitaniumSetupAction({ titaniumSignedIn }) {
  return titaniumSignedIn ? "continue" : "signIn";
}

/**
 * Follows the Titanium sign-in over time to decide when the Speech-to-Text connection
 * check must be sent again. The check's config does not change on sign-in, so without
 * this the auto-check keeps the stale refusal. `retry` is true on the render where
 * Titanium turns signed-in after the sign-in notice was showing; by then the current
 * notice has already moved on, so the notice shown while signed out is remembered.
 * Feed it every render: `next = stepSttRetry(next.state, { signedIn, notice })`.
 */
export const INITIAL_STT_RETRY_STATE = { signedIn: false, signedOutNotice: null };

export function stepSttRetry(state, { signedIn, notice }) {
  const signedInNow = Boolean(signedIn);
  const retry = !state.signedIn && signedInNow && state.signedOutNotice === "titaniumSignIn";
  return {
    retry,
    state: { signedIn: signedInNow, signedOutNotice: signedInNow ? null : notice },
  };
}

/**
 * What the Speech-to-Text settings show after the endpoint refused the request
 * with 401/403. "titaniumSignIn" replaces the API-key advice for our own host
 * while signed out; any other refusal without a key keeps the generic message.
 */
export function resolveSttEndpointNotice({
  refused,
  hasApiKey,
  isTitaniumEndpoint,
  titaniumEnabled,
  titaniumSignedIn,
}) {
  if (!refused) return null;
  if (isTitaniumEndpoint && titaniumEnabled && !titaniumSignedIn) return "titaniumSignIn";
  return hasApiKey ? null : "unauthorized";
}
