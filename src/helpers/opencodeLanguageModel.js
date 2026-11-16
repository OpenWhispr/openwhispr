// Builds the AI SDK client for one OpenCode model over its native protocol.
// Each live entry declares exactly one `api` key, so the caller's resolved
// route ({protocol, baseUrl}) picks the client deterministically:
//
//   chat-completions -> OpenAI chat        responses -> OpenAI responses
//   messages          -> Anthropic         generate-content -> Google
//
// The Bearer key is attached only to opencode.ai inference URLs: a
// renderer-supplied base URL anywhere else is refused outright, so a tampered
// payload can never send our key to an arbitrary host. Go's per-conversation
// session header rides on every protocol — it is a router-level header, not a
// Chat Completions one.
//
// This module is CommonJS because the main process owns every request:
// opencode.ai answers no CORS preflight, so the renderer can't call it.

const { resolveOpencodeModelRoute } = require("../config/opencodeModelPolicy.js");

const OPENCODE_INFERENCE_BASE_URL = /^https:\/\/opencode\.ai\/inference\//;

function createOpencodeLanguageModel({
  protocol,
  baseUrl,
  apiKey,
  modelId,
  sessionHeaders = {},
  fetch,
}) {
  const route = resolveOpencodeModelRoute({ protocol, baseUrl });
  if (!OPENCODE_INFERENCE_BASE_URL.test(route.baseUrl)) {
    throw new Error(`Refusing to send the OpenCode key to ${route.baseUrl}`);
  }
  if (!modelId) {
    throw new Error("No model specified for OpenCode API call");
  }
  const fetchOption = fetch ? { fetch } : {};
  switch (route.protocol) {
    case "responses": {
      const { createOpenAI } = require("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        baseURL: route.baseUrl,
        headers: sessionHeaders,
        ...fetchOption,
      }).responses(modelId);
    }
    case "messages": {
      // authToken sends a pure `Authorization: Bearer` header with no
      // `x-api-key`, which is what the proxy authenticates on.
      const { createAnthropic } = require("@ai-sdk/anthropic");
      return createAnthropic({
        authToken: apiKey,
        baseURL: route.baseUrl,
        headers: sessionHeaders,
        ...fetchOption,
      })(modelId);
    }
    case "generate-content": {
      // The proxy authenticates on `Authorization`; the SDK's `x-goog-api-key`
      // rides beside it (custom headers spread after it in the client).
      const { createGoogleGenerativeAI } = require("@ai-sdk/google");
      return createGoogleGenerativeAI({
        apiKey,
        baseURL: route.baseUrl,
        headers: { Authorization: `Bearer ${apiKey}`, ...sessionHeaders },
        ...fetchOption,
      })(modelId);
    }
    case "chat-completions":
    default: {
      const { createOpenAI } = require("@ai-sdk/openai");
      return createOpenAI({
        apiKey,
        baseURL: route.baseUrl,
        headers: sessionHeaders,
        ...fetchOption,
      }).chat(modelId);
    }
  }
}

module.exports = { createOpencodeLanguageModel, OPENCODE_INFERENCE_BASE_URL };
