import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getTinfoilLanguageModel } from "./tinfoilClient";
import { API_ENDPOINTS } from "../../config/constants";
import { openCodeSessionHeaders } from "./openCodeSession";
import { suppressThinking } from "./thinkingSuppressionDialects";

// Renderer-side AI SDK factory. Cloud + local only — enterprise providers
// (bedrock/azure/vertex) run in the main process via the
// `process-enterprise-reasoning` IPC because their SDKs depend on Node-only
// APIs (fs, process, AWS credential chain) that don't work in the browser.
// See `src/helpers/enterpriseAiProviders.js` for the main-process counterpart.

// OpenRouter's reasoning control and MiniMax's thinking fields are top-level
// request fields the AI SDK can't emit — inject them at the fetch boundary.
const withBodyFields =
  (fields: Record<string, unknown>): typeof fetch =>
  (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        Object.assign(body, fields);
        init = { ...init, body: JSON.stringify(body) };
      } catch {}
    }
    return fetch(input, init);
  };

export async function getAIModel(
  provider: string,
  model: string,
  apiKey: string,
  baseURL?: string,
  opts?: { disableThinking?: boolean; reasoningEffort?: string }
): Promise<LanguageModel> {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "groq":
      return createGroq({ apiKey })(model);
    case "anthropic":
      // The assistant panel runs in the pill window, which keeps Chromium's
      // default webSecurity (the deleted agent overlay disabled it). Anthropic
      // only answers browser-origin requests that opt in with this header;
      // the dictation path avoids the issue by going through IPC.
      return createAnthropic({
        apiKey,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(model);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "tinfoil":
      return getTinfoilLanguageModel(apiKey, model);
    case "corti":
      // Corti's gateway is Chat Completions-compatible, not the OpenAI Responses API.
      return createOpenAI({ apiKey, baseURL: API_ENDPOINTS.CORTI_MODELS_BASE }).chat(model);
    case "custom":
      // Custom OpenAI-compatible servers implement Chat Completions, not the Responses API.
      // One model instance answers one turn, so its session header is that turn's.
      return createOpenAI({
        apiKey,
        baseURL,
        headers: openCodeSessionHeaders(baseURL),
      }).chat(model);
    case "minimax": {
      // reasoning_split keeps M3's thinking out of the streamed text, where it
      // would otherwise arrive as <think> tags.
      const fields: Record<string, unknown> = { reasoning_split: true };
      if (opts?.disableThinking) suppressThinking(fields, "minimax", model);
      return createOpenAI({
        apiKey,
        baseURL: API_ENDPOINTS.MINIMAX_BASE,
        fetch: withBodyFields(fields),
      }).chat(model);
    }
    case "openrouter": {
      const reasoning = opts?.disableThinking
        ? { enabled: false }
        : opts?.reasoningEffort
          ? { effort: opts.reasoningEffort }
          : null;
      // OpenRouter implements Chat Completions, not the OpenAI Responses API.
      return createOpenAI({
        apiKey,
        baseURL,
        ...(reasoning ? { fetch: withBodyFields({ reasoning }) } : {}),
      }).chat(model);
    }
    case "local":
      return createOpenAI({ apiKey: apiKey || "no-key", baseURL }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
