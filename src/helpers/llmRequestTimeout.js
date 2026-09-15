const LLM_REQUEST_TIMEOUT_SECONDS = 30;
const LLM_STREAMING_TIMEOUT_SECONDS = 60;
// Note formatting sends a whole transcript through a model that may reason at
// length before writing: a 2,000-word meeting through GPT-5.6 Terra runs well
// past 30 seconds. OpenAI's own SDK defaults to a 10-minute request timeout.
const LLM_LONG_TASK_TIMEOUT_SECONDS = 600;

export const LLM_REQUEST_TIMEOUT_CODE = "LLM_REQUEST_TIMEOUT";

/**
 * Client-side deadline for one LLM request.
 * @param {{ streaming?: boolean, scope?: string }} [options] `scope` is the
 *   request's inference scope; note formatting gets the long deadline.
 */
export function getLlmRequestTimeoutSeconds({ streaming = false, scope } = {}) {
  if (streaming) return LLM_STREAMING_TIMEOUT_SECONDS;
  return scope === "noteFormatting" ? LLM_LONG_TASK_TIMEOUT_SECONDS : LLM_REQUEST_TIMEOUT_SECONDS;
}

/** The coded error a request raises when its client-side deadline expires; createApiRetryStrategy never retries it. */
export function llmRequestTimeoutError(timeoutSeconds) {
  return Object.assign(new Error(`Request timed out after ${timeoutSeconds}s`), {
    code: LLM_REQUEST_TIMEOUT_CODE,
  });
}
