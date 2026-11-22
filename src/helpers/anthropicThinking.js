// The `thinking` value that turns thinking off for Claude models that think when
// the field is omitted. Thinking counts toward max_tokens, so leaving it on for a
// short cleanup can spend the whole budget before any text is written.
// Sonnet 5.5 rejects `disabled` with a 400 and takes `between_tools` instead;
// Opus 5.5 and Fable can't turn thinking off at all, and older models don't
// think unless asked, so both get no field.
const THINKING_OFF_BY_MODEL = {
  "claude-sonnet-5-5": { type: "between_tools" },
  "claude-haiku-5-5": { type: "disabled" },
  "claude-opus-5": { type: "disabled" },
  "claude-sonnet-5": { type: "disabled" },
};

function anthropicThinkingConfig(modelId, disableThinking) {
  if (disableThinking !== true) return null;
  return THINKING_OFF_BY_MODEL[modelId] ?? null;
}

module.exports = { anthropicThinkingConfig };
