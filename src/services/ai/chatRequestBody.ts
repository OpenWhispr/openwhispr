import type { ReasoningConfig } from "../BaseReasoningService";
import { getOpenAiApiConfig, type ReasoningEffortCapability } from "../../models/ModelRegistry";
import {
  getReasoningEffortCapability,
  hasSelectableReasoningEffort,
  isReasoningEffortSupported,
  OPEN_ENDPOINT_PROVIDERS,
} from "../../models/reasoningEffort";
import { matchesHost } from "../../utils/urlUtils";
import { detectEndpointDialect } from "./thinkingSuppressionDialects";
import { getModelFamilyConstraints } from "./modelFamilyConstraints";
import { applyThinkingSuppression, isThinkingSuppressed } from "./thinkingSuppression";

/**
 * Providers whose OpenAI-compat chat endpoints speak the legacy shape: always
 * `max_tokens`, always `temperature`. Groq's registry entries carry no
 * tokenParam and its ids don't match the OpenAI fallback heuristics; Tinfoil's
 * catalog is dynamic (models outside the registry must not fall through to
 * `max_completion_tokens`); local/lan are llama.cpp-style servers.
 */
const LEGACY_CHAT_COMPLETIONS_PROVIDERS = new Set(["local", "lan", "groq", "tinfoil", "corti"]);

/**
 * Single place that turns (model, provider, endpoint, config) into the
 * parameter set of an OpenAI-compatible chat-completions body: token-limit
 * param, temperature, reasoning effort, and thinking suppression.
 * Callers own `model`/`messages`/`stream`; this owns every tunable param, so
 * a family or provider fact changed in the data tables reaches all transports
 * at once instead of one call site at a time (#1611). Responses bodies get the
 * same effort from responsesReasoningEffort; keep the two in step.
 */
export function applyChatCompletionsParams(
  requestBody: Record<string, unknown>,
  {
    model,
    provider,
    endpoint,
    config,
    maxTokens,
  }: {
    model: string;
    provider: string;
    endpoint?: string | null;
    config: ReasoningConfig;
    maxTokens: number;
  }
): void {
  const providerKey = provider.toLowerCase();
  // No systemPrompt override means the default cleanup path: a deterministic
  // transform, so zero temperature.
  const defaultTemperature = config.systemPrompt ? 0.3 : 0;

  if (LEGACY_CHAT_COMPLETIONS_PROVIDERS.has(providerKey)) {
    requestBody.max_tokens = maxTokens;
    requestBody.temperature = config.temperature ?? defaultTemperature;
  } else {
    // A known endpoint host knows its own request shape better than the model id does.
    const apiConfig = detectEndpointDialect(endpoint) ?? getOpenAiApiConfig(model, providerKey);
    requestBody[apiConfig.tokenParam] = maxTokens;
    if (apiConfig.supportsTemperature) {
      requestBody.temperature = config.temperature ?? defaultTemperature;
    }
  }

  // The user's chosen effort wins; otherwise deterministic transforms
  // (cleanup, selection edits) pin the family's preferred effort — see
  // modelFamilyConstraints for the gpt-oss rationale. A suppressed request has
  // no chosen effort, so applyThinkingSuppression still decides it.
  const familyEffort = getModelFamilyConstraints(model)?.reasoningEffort;
  const effort = chosenReasoningEffort(providerKey, model, config, endpoint);
  if (effort) {
    // OpenRouter takes effort only inside its reasoning object.
    if (providerKey === "openrouter") requestBody.reasoning = { effort };
    else requestBody.reasoning_effort = effort;
  } else if (familyEffort?.cleanupValue && isDeterministicTransform(config)) {
    requestBody.reasoning_effort = familyEffort.cleanupValue;
  }

  const suppressed = applyThinkingSuppression(
    requestBody,
    model,
    provider,
    config,
    endpoint ?? undefined
  );
  // Some dialects suppress through other fields, so a default effort beside
  // them would contradict the suppression.
  if (!suppressed && !effort && familyEffort?.defaultValue) {
    requestBody.reasoning_effort ??= familyEffort.defaultValue;
  }
}

/**
 * The effort for a Responses API body (`reasoning: { effort }`), by the same
 * rules as the chat body above. Suppression sends the family's floor, or
 * "none" like the generic chat dialect; with no choice, a model outside the
 * family table sends no effort, leaving the server's default.
 */
export function responsesReasoningEffort(
  model: string,
  provider: string,
  config: ReasoningConfig,
  endpoint?: string | null
): string | undefined {
  const familyEffort = getModelFamilyConstraints(model)?.reasoningEffort;
  if (isThinkingSuppressed(model, config)) {
    // Native OpenAI shows no toggle, so its default-on value is not the user's
    // choice: a model id the registry no longer lists keeps the server's default.
    return (
      familyEffort?.suppressValue ?? (provider.toLowerCase() === "openai" ? undefined : "none")
    );
  }
  const effort = chosenReasoningEffort(provider, model, config, endpoint);
  if (effort) return effort;
  if (familyEffort?.cleanupValue && isDeterministicTransform(config)) {
    return familyEffort.cleanupValue;
  }
  return familyEffort?.defaultValue;
}

/**
 * The levels Settings offers for this provider, model and endpoint, or null
 * when it shows no picker: thinking is suppressed, the toggle Custom and
 * OpenRouter show for every model is on, or the model has fewer than two.
 */
export function selectableReasoningEffort(
  provider: string,
  model: string,
  config: ReasoningConfig,
  endpoint?: string | null
): ReasoningEffortCapability | null {
  const providerKey = provider.toLowerCase();
  if (!model || isThinkingSuppressed(model, config)) return null;
  if (OPEN_ENDPOINT_PROVIDERS.has(providerKey) && config.disableThinking === true) return null;
  const capability = getReasoningEffortCapability(providerKey, model, endpoint);
  return hasSelectableReasoningEffort(capability) ? capability : null;
}

/**
 * The effort the user picked for this scope, when Settings offers it for this
 * provider and model. A stored level it doesn't offer (the model, provider or
 * toggle changed since) is ignored.
 */
export function chosenReasoningEffort(
  provider: string,
  model: string,
  config: ReasoningConfig,
  endpoint?: string | null
): string | undefined {
  const effort = config.reasoningEffort;
  return isReasoningEffortSupported(
    selectableReasoningEffort(provider, model, config, endpoint),
    effort
  )
    ? effort
    : undefined;
}

function isDeterministicTransform(config: ReasoningConfig): boolean {
  return !config.systemPrompt || !!config.requireCompleteOutput;
}

/** Finish reasons that mean the output hit the token cap, across providers. */
export function isTruncatedFinishReason(reason: unknown): boolean {
  return reason === "length" || reason === "max_tokens";
}

/**
 * Dictation cleanup renders these errors as the toast title, so they carry the key
 * the renderer translates. Anthropic and enterprise attach the same key on the
 * main-process side; local llama reports a code that localInferenceError.ts maps.
 */
export const TRUNCATED_OUTPUT_MESSAGE_KEY =
  "hooks.audioRecording.errorDescriptions.cleanupTruncated";
export const EMPTY_OUTPUT_MESSAGE_KEY = "hooks.audioRecording.errorDescriptions.cleanupEmptyReply";

/** Output cut off at the token cap; providers may pass their own wording for the logs. */
export function truncatedOutputError(
  message = "Model output was truncated"
): Error & { messageKey: string } {
  return Object.assign(new Error(message), { messageKey: TRUNCATED_OUTPUT_MESSAGE_KEY });
}

/** A reply with no text at all; providers pass their own wording for the logs. */
export function emptyOutputError(
  message = "Model returned an empty response"
): Error & { messageKey: string } {
  return Object.assign(new Error(message), { messageKey: EMPTY_OUTPUT_MESSAGE_KEY });
}

/**
 * Error for a completion that produced no text, or null when the caller may
 * echo its input instead. Only the default cleanup transform (no systemPrompt)
 * may echo: a prompted task would take its raw material as the finished result.
 */
export function emptyResponseError(
  providerName: string,
  config: ReasoningConfig,
  responseIncomplete: boolean
): Error | null {
  if (responseIncomplete) {
    return truncatedOutputError("Model ran out of output tokens before producing a response");
  }
  if (config.requireCompleteOutput) return emptyOutputError();
  if (config.systemPrompt) return new Error(`${providerName} returned empty response`);
  return null;
}

/**
 * Shaped params a backend may reject by name with a 400/422. Only params this
 * module's shaping layer added are strippable — never messages or model — so a
 * retry degrades the request (model reasons when asked not to, default
 * sampling) instead of failing it outright. The strip is logged loudly: a
 * fallback that keeps firing is a dialect bug to fix, not a rescue.
 */
const STRIPPABLE_SHAPED_PARAMS = [
  "reasoning_effort",
  "chat_template_kwargs",
  "thinking",
  "think",
  "temperature",
] as const;

/**
 * Values a server rejected, as `endpoint, model, param=value` → when the
 * memory expires. Keyed by value, so another effort level is still sent; the
 * expiry retries a value once the model behind the endpoint may have changed.
 */
const rejectedParams = new Map<string, number>();
const REJECTION_MEMORY_MS = 10 * 60 * 1000;

/** `remembered`: left out up front because an earlier retry proved it rejected. */
export type ParamFallbackDetails = { status?: number; stripped: string[]; remembered?: true };

/**
 * Fetch with a bounded param-stripping ladder for 400/422 rejections.
 * Rung 1 (blind): old Ollama/strict proxies reject the `reasoning` object
 * without naming it — drop it and retry once. Rung 2 (named): strip exactly
 * the shaped params the error body names and retry once. At most two retries;
 * the caller must build the body inside `doFetch` so retries re-serialize.
 * A value the error named whose removal let the retry through is left out of
 * later requests to the same endpoint and model for REJECTION_MEMORY_MS, so
 * each pays the rejection once rather than on every request. OpenRouter is
 * never remembered: it routes each request to one of several upstreams.
 */
export async function fetchWithParamFallback(
  endpoint: string,
  doFetch: () => Promise<Response>,
  requestBody: Record<string, unknown>,
  logRejection: (details: ParamFallbackDetails) => void
): Promise<Response> {
  const rejectionKey = (param: string) =>
    `${endpoint}\n${requestBody.model}\n${param}=${JSON.stringify(requestBody[param])}`;
  const remembered = ["reasoning", ...STRIPPABLE_SHAPED_PARAMS].filter(
    (param) => param in requestBody && (rejectedParams.get(rejectionKey(param)) ?? 0) > Date.now()
  );
  const canRemember = !matchesHost(endpoint, "openrouter.ai");
  if (remembered.length > 0) {
    logRejection({ stripped: remembered, remembered: true });
    for (const param of remembered) delete requestBody[param];
  }
  const readError = (response: Response) =>
    response
      .clone()
      .text()
      .catch(() => "");
  const retryWithout = async (params: readonly string[], remember: boolean) => {
    const keys = params.map(rejectionKey);
    for (const param of params) delete requestBody[param];
    const retried = await doFetch();
    if (remember && canRemember && retried.ok) {
      const expiresAt = Date.now() + REJECTION_MEMORY_MS;
      for (const key of keys) rejectedParams.set(key, expiresAt);
    }
    return retried;
  };

  let res = await doFetch();
  if (res.ok || (res.status !== 400 && res.status !== 422)) return res;

  if (requestBody.reasoning) {
    // Remembered only when the error names it: a blind 400 may have come from
    // one of several backends behind the same endpoint.
    const reasoningNamed = (await readError(res)).toLowerCase().includes("reasoning");
    logRejection({ status: res.status, stripped: ["reasoning"] });
    void res.body?.cancel();
    res = await retryWithout(["reasoning"], reasoningNamed);
    if (res.ok || (res.status !== 400 && res.status !== 422)) return res;
  }

  const errorText = await readError(res);
  const named = STRIPPABLE_SHAPED_PARAMS.filter((p) => p in requestBody && errorText.includes(p));
  if (named.length > 0) {
    logRejection({ status: res.status, stripped: named });
    void res.body?.cancel();
    res = await retryWithout(named, true);
  }
  return res;
}
