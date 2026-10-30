import ReasoningService from "./ReasoningService";
import type { ReasoningConfig } from "./BaseReasoningService";
import { providerSupportsImages } from "./ai/inferenceProviders";
import { getSettings } from "../stores/settingsStore";
import { resolveChatStreamingInference } from "../helpers/dictationAgentInference";
import { resolveModeProvider } from "../helpers/dictationRouting";
import {
  buildLocalSelectionEditSystemPrompt,
  buildLocalSelectionEditUserPrompt,
  buildSelectionEditSystemPrompt,
  buildSelectionEditUserPrompt,
  extractLocalSelectionEditReplacement,
  extractSelectionEditReplacement,
  isSelectionQuestionResponse,
  SELECTION_EDIT_RESPONSE_FORMAT,
} from "../helpers/selectionEditing";
import { appendScreenContextSuffix, resolvePrompt } from "../config/prompts";
import { getDictionaryHintWords } from "../utils/snippets";
import { getAgentName } from "../utils/agentName";
import { usePolicyStore } from "../stores/policyStore";
import { isScreenContextAllowed } from "../stores/policyRules";
import { resolveDictationToneStyle, type ToneAppCategory } from "../config/toneStyle";
import { selectionEditToneSentence } from "../config/prompts/toneStyle";
import type { ChatImageAttachment } from "../components/chat/types";

/** Null means the instruction asks about the selection; answer it in chat. */
export async function editSelectedText(
  instruction: string,
  selectedText: string,
  {
    attachment,
    appCategory,
    signal,
  }: {
    attachment?: ChatImageAttachment | null;
    appCategory?: ToneAppCategory | null;
    signal: AbortSignal;
  }
): Promise<string | null> {
  const settings = getSettings();
  const agentName = getAgentName();
  const { config: target, attachScreenContext } = resolveChatStreamingInference(settings, {
    inferenceScope: "dictationAgent",
    hasScreenContext: Boolean(attachment),
    isProviderImageWired: providerSupportsImages,
  });
  const provider = resolveModeProvider({
    isCloud: settings.isSignedIn && target.mode === "openwhispr",
    mode: target.mode,
    provider: target.provider,
  });
  const local = provider === "local";
  const marker = local ? "" : `__OPENWHISPR_SELECTION_COMPLETE_${crypto.randomUUID()}__`;
  const dictionary = getDictionaryHintWords(settings);
  const toneSentence = settings.toneStyleEnabled
    ? selectionEditToneSentence(resolveDictationToneStyle(settings.toneStyles, appCategory ?? null))
    : "";
  const systemPrompt = local
    ? buildLocalSelectionEditSystemPrompt({
        customPrompt: settings.customPrompts.dictationAgent.replaceAll("{{agentName}}", agentName),
        dictionary,
        toneSentence,
      })
    : buildSelectionEditSystemPrompt(
        [
          resolvePrompt("dictationAgent", {
            agentName,
            language: settings.preferredLanguage,
            customDictionary: dictionary,
            uiLanguage: settings.uiLanguage,
          }),
          toneSentence,
        ]
          .filter(Boolean)
          .join("\n\n"),
        marker
      );
  const config: ReasoningConfig = {
    inferenceScope: "dictationAgent",
    requiresAgent: true,
    provider,
    lanUrl: target.mode === "self-hosted" ? target.remoteUrl : undefined,
    baseUrl: target.mode === "providers" && provider === "custom" ? target.cloudBaseUrl : undefined,
    customApiKey: target.customApiKey,
    disableThinking: local || target.disableThinking,
    reasoningEffort: target.reasoningEffort,
    systemPrompt,
    maxTokens: 8192,
    contextSize: 16384,
    temperature: 0.2,
    requireCompleteOutput: true,
    ...(local
      ? { responseFormat: { ...SELECTION_EDIT_RESPONSE_FORMAT, type: "json_object" as const } }
      : {}),
    signal,
    requestId: crypto.randomUUID(),
  };
  if (attachment && attachScreenContext && isScreenContextAllowed(usePolicyStore.getState())) {
    config.screenContext = { data: attachment.image, mediaType: attachment.mediaType };
    config.systemPrompt = appendScreenContextSuffix(systemPrompt, settings.uiLanguage);
  }
  const cancel = () => {
    if (local) void window.electronAPI?.cancelLocalReasoning?.(config.requestId);
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await ReasoningService.processText(
      local
        ? buildLocalSelectionEditUserPrompt(instruction, selectedText)
        : buildSelectionEditUserPrompt(instruction, selectedText),
      target.model,
      agentName,
      config
    );
    signal.throwIfAborted();
    if (isSelectionQuestionResponse(result, marker)) return null;
    return local
      ? extractLocalSelectionEditReplacement(result)
      : extractSelectionEditReplacement(result, marker);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
