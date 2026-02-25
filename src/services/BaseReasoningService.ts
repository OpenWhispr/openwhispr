import { getSystemPrompt } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import type { AppContext } from "../types/electron";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  systemPrompt?: string;
  appContext?: AppContext | null;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getSettings().customDictionary;
  }

  protected getPreferredLanguage(): string {
    return getSettings().preferredLanguage || "auto";
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  protected getSystemPrompt(
    agentName: string | null,
    transcript?: string,
    appContext?: AppContext | null
  ): string {
    const language = this.getPreferredLanguage();
    const uiLanguage = this.getUiLanguage();
    return getSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      language,
      transcript,
      uiLanguage,
      appContext
    );
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
