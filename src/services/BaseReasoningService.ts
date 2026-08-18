import { getCleanupSystemPrompt } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import { getDictionaryHintWords } from "../utils/snippets";
import type { InferenceScope } from "../config/inferenceScopes";
import type { ScreenContextImage } from "../types/electron";

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  systemPrompt?: string;
  lanUrl?: string;
  baseUrl?: string;
  customApiKey?: string;
  provider?: string;
  disableThinking?: boolean;
  /** Screenshot attached to voice-agent requests when screen context is on. */
  screenContext?: ScreenContextImage;
  /** Suffix-free prompt used when a screenshot-carrying request is retried text-only. */
  textOnlySystemPrompt?: string;
  language?: string;
  requireCompleteOutput?: boolean;
  requiresAgent?: boolean;
  inferenceScope?: InferenceScope;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getDictionaryHintWords(getSettings());
  }

  // Auto must remain auto here: zh-CN/zh-TW instructions make cleanup write its
  // entire response in Chinese before the transcription language is known. The
  // final deterministic script pass handles likely-Chinese output instead. See #975.
  protected getPreferredLanguage(): string {
    return resolveCleanupLanguage(getSettings().preferredLanguage);
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  protected getSystemPrompt(agentName: string | null): string {
    return getCleanupSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      this.getPreferredLanguage(),
      this.getUiLanguage()
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
