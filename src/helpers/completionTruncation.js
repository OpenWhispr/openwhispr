// Truncation signals the chat-completions finish_reason can't carry. A cut-off
// cleanup reply must be treated as a failure so the raw transcription survives.
// Chat finish reasons live in chatRequestBody's isTruncatedFinishReason. See #1341.

export function isTruncatedResponsesPayload(response) {
  return (
    response?.status === "incomplete" &&
    response?.incomplete_details?.reason === "max_output_tokens"
  );
}
