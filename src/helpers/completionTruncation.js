// Truncation signals for OpenAI-compatible endpoints. A cut-off cleanup reply
// must be treated as a failure so the raw transcription survives. See #1341.

export function isTruncatedChatChoice(choice) {
  return choice?.finish_reason === "length";
}

export function isTruncatedResponsesPayload(response) {
  return (
    response?.status === "incomplete" &&
    response?.incomplete_details?.reason === "max_output_tokens"
  );
}

// One error shape for every provider's token-limit failure. See #1341.
export function truncatedResponseError(providerLabel) {
  return new Error(`${providerLabel} hit the token limit and returned a truncated response`);
}
