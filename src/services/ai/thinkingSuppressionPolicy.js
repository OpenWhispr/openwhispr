function applyThinkingSuppressionFields(requestBody, providerKey) {
  if (providerKey === "local" || providerKey === "lan") {
    requestBody.think = false;
  }

  requestBody.chat_template_kwargs = { enable_thinking: false };
}

function getGroqProviderOptions(needsDisableThinking) {
  if (!needsDisableThinking) return undefined;
  return undefined;
}

module.exports = {
  applyThinkingSuppressionFields,
  getGroqProviderOptions,
};
