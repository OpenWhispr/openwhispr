import { getCleanupSystemPrompt } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";
import { resolveCleanupLanguage } from "../utils/chineseScript";
import { getDictionaryHintWords } from "../utils/snippets";
import type { InferenceScope } from "../config/inferenceScopes";
import type { DictationToneStyle } from "../config/toneStyle";
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
  reasoningEffort?: string;
  /** Screenshot attached to voice-agent requests when screen context is on. */
  screenContext?: ScreenContextImage;
  /** Dictation cleanup only: the Tone & Style tone for the app being dictated into. */
  toneStyle?: DictationToneStyle | null;
  /** Suffix-free prompt used when a screenshot-carrying request is retried text-only. */
  textOnlySystemPrompt?: string;
  language?: string;
  requireCompleteOutput?: boolean;
  /** Bundled local server only; callers must validate the decoded response. */
  responseFormat?: { type: "json_object"; schema: Record<string, unknown> };
  /**
   * Local models only: when the prompt leaves less than `maxTokens` of room and
   * the reply fills what is left, fail as CONTEXT_TOO_LARGE instead of
   * returning a reply the context window clipped. With `requireCompleteOutput`,
   * it still lets the allowance shrink to fit, where that flag alone refuses.
   */
  refuseClippedByWindow?: boolean;
  /**
   * Tags the request so a cancel can abort it: `cancelLocalReasoning` for local
   * models, `cancelRequest` (ai/requestCancellation) for the renderer's HTTP routes.
   */
  requestId?: string;
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

  protected getSystemPrompt(
    agentName: string | null,
    toneStyle?: DictationToneStyle | null
  ): string {
    return getCleanupSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      this.getPreferredLanguage(),
      this.getUiLanguage(),
      toneStyle
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
