import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { getTinfoilLanguageModel } from "./tinfoilClient";

// Renderer-side AI SDK factory. Cloud + local only — enterprise providers
// (bedrock/azure/vertex) run in the main process via the
// `process-enterprise-reasoning` IPC because their SDKs depend on Node-only
// APIs (fs, process, AWS credential chain) that don't work in the browser.
// See `src/helpers/enterpriseAiProviders.js` for the main-process counterpart.

// OpenRouter's reasoning control is a top-level request field the AI SDK
// can't emit — inject it at the fetch boundary.
const withDisabledReasoning: typeof fetch = (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.reasoning = { enabled: false };
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
  opts?: { disableThinking?: boolean }
): Promise<LanguageModel> {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "groq":
      return createGroq({ apiKey })(model);
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "tinfoil":
      return getTinfoilLanguageModel(apiKey, model);
    case "custom":
      return createOpenAI({ apiKey, baseURL })(model);
    case "openrouter":
      // OpenRouter implements Chat Completions, not the OpenAI Responses API.
      return createOpenAI({
        apiKey,
        baseURL,
        ...(opts?.disableThinking ? { fetch: withDisabledReasoning } : {}),
      }).chat(model);
    case "local":
      return createOpenAI({ apiKey: "no-key", baseURL }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
