import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// Renderer-side AI SDK factory. Cloud + local only — enterprise providers
// (bedrock/azure/vertex) run in the main process via the
// `process-enterprise-reasoning` IPC because their SDKs depend on Node-only
// APIs (fs, process, AWS credential chain) that don't work in the browser.
// See `src/helpers/enterpriseAiProviders.js` for the main-process counterpart.

export function getAIModel(
  provider: string,
  model: string,
  apiKey: string,
  baseURL?: string
): LanguageModel {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "groq":
      return createGroq({ apiKey })(model);
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "custom":
      return createOpenAI({ apiKey, baseURL })(model);
    case "local":
      return createOpenAI({ apiKey: "no-key", baseURL }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
