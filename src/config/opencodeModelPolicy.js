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

// Free and "contributor" tiers may train on what they receive. The app
// dictates private speech, so those ids stay out even when they cost nothing.
const TRAINING_TIER_ID = /-free$|contributor/;

export function isOpencodeCatalogProvider(id) {
  return OPENCODE_CATALOG_PROVIDER_IDS.includes(id);
}

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

// The live `api` block names the protocol each model speaks. OpenCode serves
// Claude, GPT and Gemini on their own endpoints, and this transport only speaks
// Chat Completions, so only models that declare it are offered.
export function isSelectableOpencodeModel(model) {
  if (!model || model.type !== "chat") return false;
  if (!model.api?.["chat-completions"]) return false;
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
  return {
    id: model.id,
    name: name || model.id,
    description: typeof model.description === "string" ? model.description : "",
    supportsTemperature: model.capabilities?.temperature === true,
    tokenParam: "max_tokens",
  };
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
