interface ResponsesCompletionPayload {
  status?: string;
  incomplete_details?: { reason?: string };
}

export function isTruncatedResponsesPayload(
  response: ResponsesCompletionPayload | null | undefined
): boolean {
  return (
    response?.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
  );
}

export function truncatedResponseError(providerLabel: string): Error {
  return new Error(`${providerLabel} hit the token limit and returned a truncated response`);
}
