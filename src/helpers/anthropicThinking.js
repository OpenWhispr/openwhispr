const { getRegistryData } = require("../models/registryData.js");

// The `thinking` value that turns thinking off, from the model's catalog entry (`thinkingOff`):
// only models that think when the field is omitted carry one, and a model added through the
// registry works without an app release. Thinking counts toward max_tokens, so leaving it on
// for a short cleanup can spend the whole budget before any text is written.
function anthropicThinkingConfig(modelId, disableThinking) {
  if (disableThinking !== true) return null;
  const thinkingOff = getRegistryData()
    .cloudProviders.find((provider) => provider.id === "anthropic")
    ?.models.find((model) => model.id === modelId)?.thinkingOff;
  return thinkingOff ? { type: thinkingOff.type } : null;
}

module.exports = { anthropicThinkingConfig };
