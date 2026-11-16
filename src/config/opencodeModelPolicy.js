// Pure policy for OpenCode's live model lists, shared by the main-process
// catalog and the renderer's cache so both apply the same rules.

export const OPENCODE_CATALOG_PROVIDER_IDS = Object.freeze(["opencode-go", "opencode-zen"]);

// OpenCode lists these as deprecated, yet the live list still serves them and
// doesn't say so. Drop them here until the live list stops serving them.
const DEPRECATED_MODEL_IDS = new Set([
  "gpt-5-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  "glm-5",
  "kimi-k2.5",
  "minimax-m2.5",
]);

// Every live entry declares exactly one of these `api` keys, naming the
// protocol that model speaks and the base URL serving it. Routing is by that
// key alone, so there are no precedence rules: an entry with zero or several
// known keys is rejected, never guessed.
export const OPENCODE_PROTOCOLS = Object.freeze([
  "chat-completions",
  "responses",
  "messages",
  "generate-content",
]);

// Fallback inference bases, used only when a model entry carries no usable
// `base_url` (an old cache, the offline seed) — live entries always bring
// their own. The Bearer key picks the subscription, so both products share
// these until a live list says otherwise.
const OPENCODE_DEFAULT_BASE_URLS = Object.freeze({
  "chat-completions": "https://opencode.ai/inference/openai/v1",
  responses: "https://opencode.ai/inference/openai/v1",
  messages: "https://opencode.ai/inference/anthropic/v1",
  "generate-content": "https://opencode.ai/inference/google/v1beta",
});

export function isKnownOpencodeProtocol(protocol) {
  return OPENCODE_PROTOCOLS.includes(protocol);
}

export function defaultOpencodeBaseUrl(protocol) {
  return OPENCODE_DEFAULT_BASE_URLS[protocol] ?? OPENCODE_DEFAULT_BASE_URLS["chat-completions"];
}

export function isOpencodeCatalogProvider(id) {
  return OPENCODE_CATALOG_PROVIDER_IDS.includes(id);
}

// Free and "contributor" tiers may train on what they receive. The app
// dictates private speech, so those ids stay out even when they cost nothing.
const TRAINING_TIER_ID = /-free$|contributor/;

export function isSelectableOpencodeModelId(id) {
  return (
    typeof id === "string" &&
    id !== "" &&
    !TRAINING_TIER_ID.test(id) &&
    !DEPRECATED_MODEL_IDS.has(id)
  );
}

function isZeroPriced(model) {
  const text = model.cost?.text;
  return text?.input?.price === 0 && text?.output?.price === 0;
}

// The live `api` block names the protocol each model speaks. Each entry
// declares exactly one known key, and routing follows it: entries with zero
// or several are rejected rather than guessed at.
export function opencodeModelProtocol(model) {
  const api = model?.api;
  if (!api || typeof api !== "object") return undefined;
  const declared = OPENCODE_PROTOCOLS.filter((protocol) => api[protocol] != null);
  return declared.length === 1 ? declared[0] : undefined;
}

export function isSelectableOpencodeModel(model) {
  if (!model || model.type !== "chat") return false;
  if (!opencodeModelProtocol(model)) return false;
  if (isZeroPriced(model)) return false;
  return isSelectableOpencodeModelId(model.id);
}

// No supportsThinking: this transport doesn't forward disableThinking, so a
// thinking toggle would do nothing.
export function toOpencodeCatalogModel(model) {
  // OpenCode sometimes serves a model with no display name (or nothing but
  // whitespace, which reads the same). The picker renders the name verbatim,
  // so fall back to the id rather than leaving a blank row.
  const name = typeof model.name === "string" ? model.name.trim() : "";
  const protocol = opencodeModelProtocol(model) ?? "chat-completions";
  const baseUrl =
    typeof model.api?.[protocol]?.base_url === "string" && model.api[protocol].base_url
      ? model.api[protocol].base_url
      : defaultOpencodeBaseUrl(protocol);
  return {
    id: model.id,
    name: name || model.id,
    description: typeof model.description === "string" ? model.description : "",
    supportsTemperature: model.capabilities?.temperature === true,
    tokenParam: "max_tokens",
    protocol,
    baseUrl,
  };
}

// Resolves a catalog entry to the route the transport dials. Entries from an
// older build carry no protocol or base URL; they read as Chat Completions on
// the shared inference base rather than being dropped.
export function resolveOpencodeModelRoute(model) {
  const protocol =
    typeof model?.protocol === "string" && isKnownOpencodeProtocol(model.protocol)
      ? model.protocol
      : "chat-completions";
  const baseUrl =
    typeof model?.baseUrl === "string" && model.baseUrl
      ? model.baseUrl
      : defaultOpencodeBaseUrl(protocol);
  return { protocol, baseUrl };
}

export function parseOpencodeModels(payload) {
  const data = payload?.data;
  if (!Array.isArray(data)) {
    throw new Error("Malformed models list");
  }
  const seen = new Set();
  const models = [];
  for (const entry of data) {
    if (!isSelectableOpencodeModel(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(toOpencodeCatalogModel(entry));
  }
  if (models.length === 0) {
    throw new Error("OpenCode returned no chat models");
  }
  return models;
}
