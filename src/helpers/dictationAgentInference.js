import {
  resolveDictationAgentDisplayProvider,
  resolveDictationAgentProvider,
  resolveDictationAgentReachability,
  resolveModeProvider,
  resolveModeReachability,
} from "./dictationRouting.js";
import { isProviderValidForMode } from "../models/ModelRegistry";
import { getManagedScopeResolution } from "../stores/enterpriseIdentityStore";
import { selectIsCloudDictationAgentMode, selectResolvedLLMConfig } from "../stores/settingsStore";
import { inheritsFallbackEndpoint } from "./reasoningRouting.js";

// The dictation agent's inference scope, shared by the dictation route in
// audioManager and the Prompt Studio test tab so a prompt test hits the same
// provider, endpoint and credentials a real dictation does.
//
// Callers must add `systemPrompt` to the config: ReasoningService treats a
// missing one as its cleanup path, which echoes the input back instead of
// running the instruction.
export function resolveDictationAgentInference(settings, { isCloudAgent = false } = {}) {
  const managed = getManagedScopeResolution("dictationAgent", settings.enterpriseSetupMode);
  if (managed.kind === "managed") {
    return {
      reachable: settings.useDictationAgent,
      model: managed.model,
      displayProvider: managed.provider,
      config: {
        inferenceScope: /** @type {const} */ ("dictationAgent"),
        provider: managed.provider,
        disableThinking: settings.dictationAgentDisableThinking,
      },
    };
  }
  const model = settings.dictationAgentModel?.trim() || "";
  const isSelfHosted =
    settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();
  const storedProvider = settings.dictationAgentProvider?.trim() || "";
  const providerForMode = isProviderValidForMode(storedProvider, settings.dictationAgentMode)
    ? storedProvider
    : undefined;
  const provider = resolveDictationAgentProvider({
    isCloudAgent,
    dictationAgentMode: settings.dictationAgentMode,
    dictationAgentProvider: providerForMode,
  });
  const isCustom = settings.dictationAgentMode === "providers" && provider === "custom";

  return {
    reachable: resolveDictationAgentReachability({
      useDictationAgent: settings.useDictationAgent,
      dictationAgentMode: settings.dictationAgentMode,
      dictationAgentProvider: provider,
      dictationAgentModel: model,
      isCloudAgent,
      isSelfHostedAgent: isSelfHosted,
    }),
    model,
    displayProvider: resolveDictationAgentDisplayProvider({
      dictationAgentMode: settings.dictationAgentMode,
      dictationAgentProvider: providerForMode,
    }),
    config: {
      inferenceScope: /** @type {const} */ ("dictationAgent"),
      provider,
      lanUrl: isSelfHosted ? settings.dictationAgentRemoteUrl : undefined,
      baseUrl: isCustom ? settings.dictationAgentCloudBaseUrl || undefined : undefined,
      customApiKey:
        isCustom || isSelfHosted ? settings.dictationAgentCustomApiKey || undefined : undefined,
      disableThinking: settings.dictationAgentDisableThinking,
    },
  };
}

// The optional vision override: the scope a voice-agent request uses when it
// carries a screen-context screenshot. Resolved through the store selector so
// unset fields inherit the agent's own config, and treated as "active" only
// once the user has actually chosen a target — an inherited config is the
// agent scope, which the base routing rules already cover.
export function resolveDictationAgentVisionInference(settings, { isSignedIn = false } = {}) {
  const resolved = selectResolvedLLMConfig(settings, "dictationAgentVision");
  const mode = resolved.mode;
  const isCloud = isSignedIn && mode === "openwhispr" && resolved.cloudMode === "openwhispr";
  const model = resolved.model?.trim() || "";
  const storedProvider = resolved.provider?.trim() || "";
  const providerForMode = isProviderValidForMode(storedProvider, mode) ? storedProvider : undefined;
  const provider = resolveModeProvider({ isCloud, mode, provider: providerForMode });
  const isCustom = mode === "providers" && provider === "custom";

  // Cloud needs no model of its own, so selecting it counts as a choice;
  // otherwise the user must have picked a model for this scope specifically.
  const chosen = isCloud || !!settings.dictationAgentVisionModel?.trim();

  // The endpoint falls back to the agent scope, so the key that opens it must
  // too — an inherited endpoint with only the vision key (or none) would call
  // the agent's host with the wrong credential.
  const agent = selectResolvedLLMConfig(settings, "dictationAgent");
  const borrowsAgentEndpoint = inheritsFallbackEndpoint(
    { mode, cloudBaseUrl: settings.dictationAgentVisionCloudBaseUrl },
    agent.mode
  );
  const customApiKey =
    resolved.customApiKey || (borrowsAgentEndpoint ? agent.customApiKey || "" : "");

  return {
    active:
      !!settings.useDictationAgentVisionModel &&
      chosen &&
      resolveModeReachability({ mode, provider, model, isCloud, isSelfHosted: false }),
    mode,
    // Cloud picks the model server-side from its vision chain.
    model: isCloud ? "" : model,
    config: {
      // The vision override is the agent's image lane: policy and managed
      // enforcement must judge it as the agent scope, not dictation cleanup.
      inferenceScope: /** @type {const} */ ("dictationAgent"),
      provider,
      baseUrl: isCustom ? resolved.cloudBaseUrl || undefined : undefined,
      customApiKey: isCustom ? customApiKey || undefined : undefined,
      disableThinking: resolved.disableThinking,
    },
  };
}

/**
 * What the voice assistant panel streams a standalone command on. The panel
 * runs on the Voice Assistant scope — the same settings tab that governs
 * selection edits — so the model the user picks there is the one that answers.
 * A screenshot swaps in the vision override when the user configured one and
 * it can actually see images; an override that cannot drops the screenshot
 * rather than quietly redirecting it to a model the user did not choose,
 * mirroring resolveAgentImageTarget on the dictation route.
 *
 * The Voice Assistant scope shipped with an empty provider and model and was
 * never seeded from the Chat scope, so profiles that configured Chat before
 * the onboarding fan-out existed hold an unreachable Voice Assistant scope
 * while their panel worked on Chat. Those keep working: an unreachable Voice
 * Assistant scope (or the assistant toggled off) falls back to the Chat scope,
 * the panel's previous home, and a reachable one is honored.
 *
 * `isProviderImageWired` is injected (the provider registry reads Vite env at
 * load, which this helper's callers and tests do not all have).
 *
 * @param {import("../stores/settingsStore").SettingsState} settings
 * @param {{
 *   hasScreenContext?: boolean,
 *   isProviderImageWired?: (providerId: string | undefined) => boolean,
 * }} [options]
 * @returns {{
 *   config: import("../stores/settingsStore").ResolvedLLMConfig,
 *   dropScreenContext: boolean,
 * }}
 */
export function resolveAssistantPanelInference(
  settings,
  { hasScreenContext = false, isProviderImageWired = () => false } = {}
) {
  const reachable = resolveDictationAgentInference(settings, {
    isCloudAgent: selectIsCloudDictationAgentMode(settings),
  }).reachable;
  if (!reachable) {
    return {
      config: selectResolvedLLMConfig(settings, "chatIntelligence"),
      dropScreenContext: false,
    };
  }

  const agent = selectResolvedLLMConfig(settings, "dictationAgent");
  if (!hasScreenContext) return { config: agent, dropScreenContext: false };

  const vision = resolveDictationAgentVisionInference(settings, {
    isSignedIn: !!settings.isSignedIn,
  });
  if (!vision.active) return { config: agent, dropScreenContext: false };
  if (!isProviderImageWired(vision.config.provider)) {
    return { config: agent, dropScreenContext: true };
  }
  return {
    config: {
      scope: "dictationAgentVision",
      mode: vision.mode,
      provider: vision.config.provider,
      model: vision.model,
      cloudBaseUrl: vision.config.baseUrl,
      customApiKey: vision.config.customApiKey,
      disableThinking: vision.config.disableThinking,
    },
    dropScreenContext: false,
  };
}
