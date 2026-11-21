import { isTitaniumServiceUrl } from "./titaniumHosts.js";

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
 * while signed out; "titaniumNoLicense" replaces it for a signed-in account that
 * holds no license (the refusal is the license gate, not a missing key, so an API key
 * is never suggested); any other refusal without a key keeps the generic message.
 * `titaniumLicensed`/`titaniumLicenseReason` come from the Titanium session
 * (`licensed`, `reason`); omitted means unknown and changes nothing.
 */
export function resolveSttEndpointNotice({
  refused,
  hasApiKey,
  isTitaniumEndpoint,
  titaniumEnabled,
  titaniumSignedIn,
  titaniumLicensed,
  titaniumLicenseReason,
}) {
  if (!refused) return null;
  if (isTitaniumEndpoint && titaniumEnabled && !titaniumSignedIn) return "titaniumSignIn";
  if (
    isTitaniumEndpoint &&
    titaniumEnabled &&
    titaniumLicensed === false &&
    titaniumLicenseReason === "no_license"
  ) {
    return "titaniumNoLicense";
  }
  return hasApiKey ? null : "unauthorized";
}

/**
 * The Settings "EdgeAssistant cloud" speech-to-text tab is a derived view over the
 * existing fields (no persisted mode of its own): it is current when Titanium is
 * offered, the cloud route is Custom (not local) and its endpoint is one of our
 * hosts. `destinationUrl` is where requests actually go (transcriptionDestinationUrl),
 * so a retained self-hosted URL that wins routing keeps the Self-Hosted tab. Anything else keeps the `mode` the store derived.
 */
export function resolveTranscriptionEngineTab({
  mode,
  useLocalWhisper,
  cloudTranscriptionMode,
  cloudTranscriptionProvider,
  titaniumEnabled,
  destinationUrl,
  forkConfig,
}) {
  const isTitaniumRoute =
    titaniumEnabled &&
    !useLocalWhisper &&
    cloudTranscriptionMode === "byok" &&
    cloudTranscriptionProvider === "custom" &&
    isTitaniumServiceUrl(destinationUrl, forkConfig);
  return isTitaniumRoute ? "titanium" : mode;
}

/**
 * The transcription settings that select EdgeAssistant cloud (setup card and Settings
 * tab). The saved self-hosted URL and model are cleared because the route resolver
 * prefers them under transcriptionMode "self-hosted" (which byok + custom persists),
 * which would send audio to the old server.
 */
export function titaniumEngineSettings(defaultStt) {
  return {
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: defaultStt.baseUrl,
    cloudTranscriptionModel: defaultStt.model,
  };
}

/**
 * Extra settings to write when leaving the EdgeAssistant cloud tab. Its endpoint is
 * cleared only when it is one of our hosts; a base URL of the user's own is kept.
 */
export function settingsOnLeavingTitaniumEngine({ isTitaniumUrl }) {
  return isTitaniumUrl ? { cloudTranscriptionBaseUrl: "" } : {};
}

/** License state shown in the EdgeAssistant cloud panel: signedOut, noLicense or licensed. */
export function resolveTitaniumEngineState({ signedIn, licensed, reason }) {
  if (!signedIn || reason === "signed_out") return "signedOut";
  return licensed ? "licensed" : "noLicense";
}
