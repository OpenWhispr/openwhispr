import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getTinfoilLanguageModel } from "./tinfoilClient";
import { API_ENDPOINTS } from "../../config/constants";
import { openCodeSessionHeaders } from "./openCodeSession";

// Renderer-side AI SDK factory. Cloud + local only — enterprise providers
// (bedrock/azure/vertex) run in the main process via the
// `process-enterprise-reasoning` IPC because their SDKs depend on Node-only
// APIs (fs, process, AWS credential chain) that don't work in the browser.
// See `src/helpers/enterpriseAiProviders.js` for the main-process counterpart.

// OpenRouter's reasoning control is a top-level request field the AI SDK
// can't emit — inject it at the fetch boundary.
const withReasoning =
  (reasoning: Record<string, unknown>): typeof fetch =>
  (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.reasoning = reasoning;
        init = { ...init, body: JSON.stringify(body) };
      } catch {}
    }
    return fetch(input, init);
  };

// Same pattern for GenieX (the Snapdragon NPU runtime): its thinking switch
// (`enable_think`) is a top-level body field the AI SDK can't emit, and it
// ignores llama.cpp's chat_template_kwargs dialect — a thinking model would
// spend the reply budget in reasoning_content and chat would show nothing.
const withEnableThink =
  (value: unknown): typeof fetch =>
  (input, init) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.enable_think = value;
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
  opts?: { disableThinking?: boolean; reasoningEffort?: string; enableThink?: boolean }
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
        ...(reasoning ? { fetch: withReasoning(reasoning) } : {}),
      }).chat(model);
    }
    case "local":
      return createOpenAI({
        apiKey: apiKey || "no-key",
        baseURL,
        // GenieX (NPU) models need enable_think on every request; the AI SDK
        // can't emit it, so it is injected at the fetch boundary.
        ...(opts?.enableThink ? { fetch: withEnableThink(false) } : {}),
      }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
