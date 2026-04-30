import type { ReasoningConfig } from "../../BaseReasoningService";

export interface ProviderContext {
  getApiKey(provider: string): Promise<string>;
  getSystemPrompt(agentName: string | null): string;
  getCustomDictionary(): string[];
  getPreferredLanguage(): string;
  getUiLanguage(): string;
  callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string>;
  calculateMaxTokens(
    textLength: number,
    minTokens?: number,
    maxTokens?: number,
    multiplier?: number
  ): number;
}

export interface ProviderCallParams {
  text: string;
  model: string;
  agentName: string | null;
  config: ReasoningConfig;
  ctx: ProviderContext;
}

export interface InferenceProvider {
  readonly id: string;
  call(params: ProviderCallParams): Promise<string>;
}
