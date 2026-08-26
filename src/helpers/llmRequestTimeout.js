const LLM_REQUEST_TIMEOUT_SECONDS = 30;
const LLM_STREAMING_TIMEOUT_SECONDS = 60;

export function getLlmRequestTimeoutSeconds(params = {}) {
  const { streaming = false } = params && typeof params === "object" ? params : {};
  return streaming ? LLM_STREAMING_TIMEOUT_SECONDS : LLM_REQUEST_TIMEOUT_SECONDS;
}
