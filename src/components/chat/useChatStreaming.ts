import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReasoningService, { type AgentStreamChunk } from "../../services/ReasoningService";
import { isEnterpriseProvider } from "../../models/ModelRegistry";
import { providerSupportsImages } from "../../services/ai/inferenceProviders";
import { getSettings, useSettingsStore } from "../../stores/settingsStore";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import logger from "../../utils/logger";
import {
  isAgentAllowed,
  isConnectorsAllowed,
  isLlmSelectionAllowed,
  isWebSearchAllowed,
} from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import { getUsageState } from "../../lib/usageStore";
import { readIsSubscribed } from "../../lib/subscriptionFlag";
import { hasConnectorPlan } from "../../utils/connectorEligibility";
import { resolveEmailDraftTarget } from "../../utils/emailDraftTarget";
import { ensureConnectorStatus, isConnectorReady } from "../../stores/connectorStatusStore";
import {
  appendDictionarySuffix,
  appendPlainTextResponseSuffix,
  appendScreenContextSuffix,
  buildVoiceTurnMessage,
  getAgentSystemPrompt,
  getAgentSystemPromptParts,
  getVoiceReplyInstructions,
} from "../../config/prompts";
import { getDictionaryHintWords } from "../../utils/snippets";
import { buildVoiceHistory } from "../../services/voice/voiceHistory";
import { compactToolResultForVoice } from "../../services/voice/voiceTools";
import {
  createWriteOnceGuard,
  isBlockedRepeat,
  runToolResultOnce,
  VOICE_EXCLUDED_TOOLS,
  type ToolResultLike,
  type WriteOnceGuard,
} from "../../services/voice/voiceToolPolicy";
import type { AssistantSpeechTap } from "../../services/voice/types";
import { createToolRegistry } from "../../services/tools";
import {
  executeTool,
  type HoldDeliveryOptions,
  type ToolRegistry,
} from "../../services/tools/ToolRegistry";
import { createToolExecutionScope, type ToolExecutionScope } from "./toolExecutionScope";
import { getAgentToolActivityRemainingMs } from "../../helpers/agentToolPresentation";
import type { Message, AgentState, ChatImageAttachment, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";
import {
  buildAgentRequestText,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";
import { estimateModelSizeB } from "../../utils/localModelSize";

const RAG_NOTE_LIMIT = 5;
const RAG_NOTE_SNIPPET_LENGTH = 500;
const STREAM_FLUSH_INTERVAL_MS = 32;

const LOCAL_TOOL_MIN_PARAMS_B = 4;
// Voice turns on a local model: stops one that loops. Speech is already capped at three
// sentences, so this only has to leave room for tool arguments (a dictated note, up to a
// 30-second turn) and the answer. Other providers get no cap: a reasoning model spends
// its thinking tokens from the same budget and would return nothing to say.
const VOICE_LOCAL_MAX_OUTPUT_TOKENS = 1024;

async function buildRAGContext(userText: string, scope?: ContainerScope): Promise<string> {
  if (!window.electronAPI?.semanticSearchNotes) return "";
  try {
    const results = await window.electronAPI.semanticSearchNotes(
      userText,
      RAG_NOTE_LIMIT,
      scope?.spaceId ?? null,
      scope?.folderId ?? null
    );
    if (!results || results.length === 0) return "";

    const snippets = await Promise.all(
      results.map(async (r: { id: number; title: string; score?: number }) => {
        const note = await window.electronAPI.getNote(r.id);
        if (!note) return null;
        const content = (note.content || "").slice(0, RAG_NOTE_SNIPPET_LENGTH);
        return `<note id="${note.id}" title="${note.title}">\n${content}\n</note>`;
      })
    );

    return snippets.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Which settings scope answers a conversation. Typed chat surfaces stay on the
 * Chat scope; the voice assistant panel runs on the Voice Assistant scope so
 * the model picked under Settings > Voice Assistant is the one that answers
 * (see resolveChatStreamingInference for its Chat fallback).
 */
export type ChatStreamingScope = "chatIntelligence" | "dictationAgent";

interface UseChatStreamingOptions {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /** Settings scope the conversation resolves its provider and model from. */
  inferenceScope?: ChatStreamingScope;
  /** Optional note context to prepend to the system prompt (used by embedded note chat). */
  noteContext?: string;
  /** Optional container scope applied to RAG and the search_notes tool (container overview chat). */
  searchScope?: ContainerScope;
  /**
   * Offer connector tools (email drafts, contact lookup) when the plan and
   * policy allow them. Off unless a surface opts in: they act outside the app.
   */
  allowConnectors?: boolean;
  onStreamComplete?: (assistantId: string, content: string, toolCalls?: ToolCallInfo[]) => void;
  /** Fires exactly once when displayable assistant content or tool activity becomes available. */
  onResponseContent?: () => void;
}

const DRY_RUN_RESULT = { success: true, dryRun: true, note: "Test run: nothing was changed." };

/**
 * Voice turns get compacted tool results (see compactToolResultForVoice) and run
 * each write tool at most once (see createWriteOnceGuard); in the harness, the
 * tools named in `dryRunNames` return a canned success instead.
 */
function prepareVoiceTools(
  tools: ReturnType<ToolRegistry["toAISDKFormat"]> | undefined,
  {
    dryRunNames,
    guard,
    onBlockedRepeat,
  }: { dryRunNames: Set<string>; guard: WriteOnceGuard; onBlockedRepeat: (callId: string) => void }
): ReturnType<ToolRegistry["toAISDKFormat"]> | undefined {
  if (!tools) return tools;
  const prepared: ReturnType<ToolRegistry["toAISDKFormat"]> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    prepared[name] = execute
      ? ({
          ...tool,
          execute: async (...args: Parameters<typeof execute>) => {
            const result = await guard.run(name, async () =>
              dryRunNames.has(name)
                ? DRY_RUN_RESULT
                : compactToolResultForVoice(name, await execute(...args))
            );
            if (isBlockedRepeat(result)) onBlockedRepeat(args[1].toolCallId);
            return result;
          },
        } as typeof tool)
      : tool;
  }
  return prepared;
}

export interface SendToAIOptions {
  /** Screenshot for this message; attached only when the resolved model can see it. */
  attachment?: ChatImageAttachment;
  /** Agent-response selection attached to this request without changing chat history. */
  selectedContext?: AgentSelectionContext;
  /** Keeps a caret-destined voice response in the compact pill while it streams. */
  suppressResponseContent?: boolean;
  /** Asks the model for plain prose because the answer will be pasted into a plain-text app. */
  plainTextResponse?: boolean;
  /** Per-request completion hook used to deliver a finished voice response. */
  onComplete?: (result: {
    assistantId: string;
    content: string;
    toolCalls?: ToolCallInfo[];
  }) => void | Promise<void>;
  /** Fires when a tool shows an approval card, so a hidden panel can open. */
  onApprovalRequested?: () => void;
  /** Fires when this turn's answer must not be pasted at the caret (see ToolExecutionContext). */
  onHoldDelivery?: (options?: HoldDeliveryOptions) => void;
  /**
   * Voice conversation: this request answers a spoken turn. It gets the voice prompt
   * and limits, and the tap hears the answer as it streams and when it ends.
   */
  voiceTap?: AssistantSpeechTap;
}

export interface ChatStreaming {
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  sendToAI: (userText: string, allMessages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancelStream: () => void;
}

type HistoryMessage = { role: string; content: string | Array<Record<string, unknown>> };

// Walks backward to the newest user message; a null transform keeps walking.
function transformLastUserMessage(
  history: HistoryMessage[],
  transform: (message: HistoryMessage) => HistoryMessage | null
): void {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const replacement = transform(history[i]);
    if (replacement === null) continue;
    history[i] = replacement;
    break;
  }
}

export function useChatStreaming({
  messages,
  setMessages,
  inferenceScope = "chatIntelligence",
  noteContext: externalNoteContext,
  searchScope,
  allowConnectors = false,
  onStreamComplete,
  onResponseContent,
}: UseChatStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
  // Voice turns: each user message exactly as sent, so later turns replay it verbatim.
  // Tool steps are deliberately not replayed: Qwen3.5's template renders an assistant
  // turn differently once a newer question follows, so they can never match the cache.
  const voiceSentContentRef = useRef(new Map<string, string>());
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const mountedRef = useRef(true);
  const messagesRef = useRef<Message[]>([]);
  const noteContextRef = useRef(externalNoteContext);
  noteContextRef.current = externalNoteContext;
  const searchScopeRef = useRef(searchScope);
  searchScopeRef.current = searchScope;
  const toolRegistryRef = useRef<{ key: string; registry: ToolRegistry } | null>(null);
  const toolActivityStartedAtRef = useRef<number | null>(null);
  const toolActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearToolActivityTimer = useCallback(() => {
    if (toolActivityTimerRef.current) {
      clearTimeout(toolActivityTimerRef.current);
      toolActivityTimerRef.current = null;
    }
  }, []);

  const clearToolActivity = useCallback(() => {
    clearToolActivityTimer();
    toolActivityStartedAtRef.current = null;
    if (!mountedRef.current) return;
    setToolStatus("");
    setActiveToolName("");
  }, [clearToolActivityTimer]);

  const beginToolActivity = useCallback(
    (name: string, status: string) => {
      clearToolActivityTimer();
      toolActivityStartedAtRef.current = Date.now();
      setActiveToolName(name);
      setToolStatus(status);
    },
    [clearToolActivityTimer]
  );

  const completeToolActivity = useCallback(() => {
    const startedAt = toolActivityStartedAtRef.current;
    if (startedAt == null) {
      clearToolActivity();
      return;
    }

    const remainingMs = getAgentToolActivityRemainingMs(startedAt);
    clearToolActivityTimer();
    if (remainingMs === 0) {
      clearToolActivity();
      return;
    }

    toolActivityTimerRef.current = setTimeout(clearToolActivity, remainingMs);
  }, [clearToolActivity, clearToolActivityTimer]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const sendGenerationRef = useRef(0);
  // Generation stamped by the most recent cancel issued while still mounted
  // (Esc, a Stop button). The unmount cleanup below flips mountedRef off
  // before routing through cancelStream, so it never stamps this — which is
  // how sendToAI tells a user's cancel from an unmount mid-stream.
  const explicitCancelGenerationRef = useRef(0);
  const toolScopeRef = useRef<ToolExecutionScope | null>(null);
  const cancelStream = useCallback(() => {
    sendGenerationRef.current += 1;
    if (mountedRef.current) {
      explicitCancelGenerationRef.current = sendGenerationRef.current;
    }
    toolScopeRef.current?.abort();
    toolScopeRef.current = null;
    ReasoningService.cancelActiveStream();
    setAgentState("idle");
    clearToolActivity();
  }, [clearToolActivity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Route through cancelStream so every cancellation path — Esc/Stop and
      // an unmount mid-stream alike — bumps the same generation counter.
      // Calling ReasoningService.cancelActiveStream() directly here (as this
      // used to) left sendToAI's cancelled() check unaware of an unmount
      // cancel, so its empty-response fallback still fired and persisted a
      // fabricated reply for a send the user never saw complete.
      cancelStream();
    };
  }, [cancelStream]);

  const sendToAI = useCallback(
    async (userText: string, allMessages: Message[], options?: SendToAIOptions) => {
      const sendGeneration = ++sendGenerationRef.current;
      const cancelled = () => sendGeneration !== sendGenerationRef.current;
      // This send supersedes any still running, so that turn's tools are
      // released now rather than when (or if) they settle.
      toolScopeRef.current?.abort();
      const toolScope = createToolExecutionScope({
        onApprovalRequested: options?.onApprovalRequested,
        onHoldDelivery: options?.onHoldDelivery,
      });
      toolScopeRef.current = toolScope;
      clearToolActivity();

      // Every exit, thrown errors included, releases tools still waiting on
      // this turn (an approval card would otherwise sit out its TTL). A newer
      // send may already own toolScopeRef.
      try {
        await runSend();
      } finally {
        toolScope.abort();
        if (toolScopeRef.current === toolScope) toolScopeRef.current = null;
      }

      async function runSend(): Promise<void> {
        let responseAnnounced = false;
        const announceResponse = () => {
          if (responseAnnounced) return;
          responseAnnounced = true;
          if (!options?.suppressResponseContent) onResponseContent?.();
        };
        const voiceTap = options?.voiceTap ?? null;
        const voiceTurn = voiceTap !== null;
        const settings = getSettings();
        const { config: resolvedConfig, attachScreenContext } = resolveChatStreamingInference(
          settings,
          {
            inferenceScope,
            hasScreenContext: !!options?.attachment,
            isProviderImageWired: providerSupportsImages,
          }
        );
        // Voice conversation harness: pin voice turns to a local model (OPENWHISPR_VOICE_HARNESS_BRAIN)
        // so model comparisons don't depend on, or change, the user's settings.
        const voiceModelOverride = voiceTap?.brainOverride ?? null;
        const llmConfig = voiceModelOverride
          ? {
              ...resolvedConfig,
              mode: "local" as const,
              provider: "local",
              model: voiceModelOverride,
            }
          : resolvedConfig;
        const requestedAttachment = attachScreenContext ? (options?.attachment ?? null) : null;
        const llmMode = llmConfig.mode || "openwhispr";
        const policyState = usePolicyStore.getState();
        const policyProvider =
          llmMode === "openwhispr"
            ? "openwhispr"
            : llmMode === "local"
              ? "local"
              : llmConfig.provider;
        if (
          !isAgentAllowed(policyState) ||
          !isLlmSelectionAllowed(policyState, { mode: llmMode, provider: policyProvider })
        ) {
          // The user message is already appended; answer it instead of dead-ending silently.
          const restriction = !isAgentAllowed(policyState)
            ? t("common.policyAgentRestricted")
            : t("common.policyAiProcessingRestricted");
          announceResponse();
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: restriction,
              isStreaming: false,
            },
          ]);
          voiceTap?.onResponseDone();
          return;
        }

        setAgentState("thinking");
        const isCloudAgent = llmMode === "openwhispr" && settings.isSignedIn;
        const isLanAgent = llmMode === "self-hosted" && !!llmConfig.remoteUrl;
        const isCustomAgent = llmMode === "providers" && llmConfig.provider === "custom";
        const isLocalProvider =
          !isEnterpriseProvider(llmConfig.provider) &&
          ![
            "openai",
            "groq",
            "custom",
            "anthropic",
            "gemini",
            "tinfoil",
            "openrouter",
            "corti",
          ].includes(llmConfig.provider);
        const localModelCanUseTool =
          isLocalProvider && estimateModelSizeB(llmConfig.model) >= LOCAL_TOOL_MIN_PARAMS_B;
        const supportsTools = isCloudAgent || !isLocalProvider || localModelCanUseTool;

        const scope = searchScopeRef.current;
        let registry: ToolRegistry | null = null;
        if (supportsTools) {
          const scopeKey = scope ? `${scope.spaceId}:${scope.folderId ?? ""}` : "";
          // The calendar tool reads the shared provider-deduped events table,
          // so any connected provider enables it.
          const calendarConnected =
            settings.gcalConnected || settings.mcalConnected || settings.appleCalendarConnected;
          const webSearchEnabled = isWebSearchAllowed(usePolicyStore.getState());
          const connectorsAvailable =
            allowConnectors &&
            settings.isSignedIn &&
            hasConnectorPlan(getUsageState(), readIsSubscribed()) &&
            isConnectorsAllowed(usePolicyStore.getState());
          // The first send in a window must not miss a connected Slack.
          if (connectorsAvailable) await ensureConnectorStatus();
          const slackReady = connectorsAvailable && isConnectorReady("slack");
          const connectors = connectorsAvailable
            ? { emailDraftTarget: resolveEmailDraftTarget(settings), slackReady }
            : undefined;
          // Triggers ride in the tool description, so a snippet edit rebuilds the registry.
          const snippetKey = settings.snippets.map((s) => s.trigger).join("|");
          // A voice turn changes which tools this registry may offer (voice turns
          // exclude snippet editing), so it must be part of the cache key too —
          // otherwise a registry built for one kind of turn gets reused for the other.
          const cacheKey = `${settings.isSignedIn}-${calendarConnected}-${settings.cloudBackupEnabled}-${scopeKey}-${webSearchEnabled}-${snippetKey}-${connectors?.emailDraftTarget ?? "no-connectors"}-${slackReady}-${voiceTurn}`;
          if (toolRegistryRef.current?.key === cacheKey) {
            registry = toolRegistryRef.current.registry;
          } else {
            registry = createToolRegistry({
              isSignedIn: settings.isSignedIn,
              calendarConnected,
              cloudBackupEnabled: settings.cloudBackupEnabled,
              searchScope: scope,
              webSearchEnabled,
              vocabulary: {
                getDictionary: () => getSettings().customDictionary,
                updateDictionary: (changes) =>
                  useSettingsStore.getState().updateCustomDictionary(changes),
                getSnippets: () => getSettings().snippets,
                setSnippets: (snippets) => useSettingsStore.getState().setSnippets(snippets),
              },
              connectors,
              ...(voiceTurn ? { excludeTools: VOICE_EXCLUDED_TOOLS } : {}),
            });
            toolRegistryRef.current = { key: cacheKey, registry };
          }
        }

        const ragContext = await buildRAGContext(userText, scope);
        if (cancelled() || !mountedRef.current) return;
        const combinedContext = [noteContextRef.current, ragContext].filter(Boolean).join("\n\n");
        const toolNames = registry?.getAll().map((t) => t.name);
        const promptParts = voiceTurn
          ? getAgentSystemPromptParts(toolNames, combinedContext || undefined)
          : null;
        voiceTap?.onToolsAvailable(toolNames ?? []);
        // The user's dictionary rides on every conversation so replies use their
        // jargon — same suffix the dictation prompts carry.
        let systemPrompt = appendDictionarySuffix(
          promptParts
            ? `${promptParts.stable}\n\n${getVoiceReplyInstructions(toolNames)}`
            : getAgentSystemPrompt(toolNames, combinedContext || undefined),
          getDictionaryHintWords(settings),
          settings.uiLanguage
        );

        const history: HistoryMessage[] = promptParts
          ? buildVoiceHistory(
              allMessages,
              voiceSentContentRef.current,
              promptParts.turnContext,
              buildVoiceTurnMessage
            )
          : allMessages.slice(-20).map((m) => ({ role: m.role, content: m.content }));

        const selectedContext = options?.selectedContext;
        if (selectedContext) {
          transformLastUserMessage(history, (message) =>
            typeof message.content === "string"
              ? { ...message, content: buildAgentRequestText(message.content, selectedContext) }
              : null
          );
        }

        // A screenshot the resolver kept rides with the command it came with:
        // BYOK models get it as an image part, the cloud agent as a dedicated
        // field the server vision-routes (older servers strip the unknown field,
        // which degrades to a plain command). A dropped one costs nothing but the
        // image — the command still runs.
        const attachment = requestedAttachment && !isCloudAgent ? requestedAttachment : null;
        const cloudScreenContext =
          requestedAttachment && isCloudAgent
            ? { data: requestedAttachment.image, mediaType: requestedAttachment.mediaType }
            : null;
        if (attachment) {
          // The screenshot needs its grounding instruction, exactly like the
          // dictation path pairs the suffix with an attached image. Restore it
          // for cloud context once openwhispr-api#157 vision-routes that field.
          systemPrompt = appendScreenContextSuffix(systemPrompt, settings.uiLanguage);
        }
        if (options?.plainTextResponse) {
          systemPrompt = appendPlainTextResponseSuffix(systemPrompt);
        }
        if (attachment) {
          transformLastUserMessage(history, (message) => ({
            role: "user",
            content: [
              { type: "text", text: message.content as string },
              { type: "image", image: attachment.image, mediaType: attachment.mediaType },
            ],
          }));
        }

        const llmMessages = [{ role: "system", content: systemPrompt }, ...history];

        const assistantId = crypto.randomUUID();
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "", isStreaming: true },
        ]);
        setAgentState("streaming");

        // Chat re-parses the whole answer through react-markdown on every
        // content write, so one write per streamed token made parse cost scale
        // with token count. Buffer and flush at most once per interval.
        let fullContent = "";
        let contentFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const cancelContentFlush = () => {
          if (contentFlushTimer === null) return;
          clearTimeout(contentFlushTimer);
          contentFlushTimer = null;
        };
        const flushContentNow = () => {
          cancelContentFlush();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
          );
        };
        const scheduleContentFlush = () => {
          if (contentFlushTimer !== null) return;
          contentFlushTimer = setTimeout(flushContentNow, STREAM_FLUSH_INTERVAL_MS);
        };

        try {
          let stream: AsyncGenerator<AgentStreamChunk>;
          // Each call's own step text on the AI SDK path, whose tool results
          // carry only the model-facing output (the cloud path yields it).
          const toolDisplayTexts = new Map<string, string>();

          // Shared by both branches below: OpenWhispr Cloud runs tools via
          // executeToolCall, BYOK/local runs them via the AI SDK's registry.toAISDKFormat()
          // wrapper, but "each write tool runs at most once per voice turn" applies to
          // whichever one actually answers this request. One guard per request, so
          // "once per turn" resets with each spoken turn.
          const writeToolNames = new Set(
            (registry?.getAll() ?? []).filter((tool) => !tool.readOnly).map((tool) => tool.name)
          );
          const dryRunNames = voiceTap?.dryRunWrites ? writeToolNames : new Set<string>();
          // A write that settles after a barge-in cancelled this request belongs to no turn.
          const writeOnceGuard = voiceTap
            ? createWriteOnceGuard(writeToolNames, (name, ok) => {
                if (!cancelled()) voiceTap.onWriteToolResult(name, ok);
              })
            : null;
          // Nothing ran for a repeat the guard blocked, so its tool chip is dropped.
          const blockedRepeatCallIds = new Set<string>();

          if (isCloudAgent) {
            const executeToolCall = registry
              ? async (name: string, argsJson: string, toolCallId: string) => {
                  const tool = registry.get(name);
                  if (!tool)
                    return {
                      data: `Unknown tool: ${name}`,
                      displayText: t("agentMode.tools.unknownTool", { name }),
                    };
                  let args: Record<string, unknown>;
                  try {
                    args = JSON.parse(argsJson);
                  } catch {
                    return {
                      data: `Invalid tool arguments for ${name}`,
                      displayText: t("agentMode.tools.invalidArgs", { name }),
                    };
                  }
                  const execute = () =>
                    dryRunNames.has(name)
                      ? Promise.resolve({
                          success: true,
                          data: DRY_RUN_RESULT,
                          displayText: DRY_RUN_RESULT.note,
                        })
                      : executeTool(
                          tool,
                          args,
                          toolScope.createContext({ messageId: assistantId, toolCallId })
                        );
                  const result: ToolResultLike = writeOnceGuard
                    ? await runToolResultOnce(writeOnceGuard, name, execute)
                    : await execute();
                  if (result.blocked) blockedRepeatCallIds.add(toolCallId);
                  const modelData = voiceTurn
                    ? compactToolResultForVoice(name, result.data)
                    : result.data;
                  // A blocked repeat's data is the guard's note to the model, even after a failure.
                  const data =
                    result.success || result.blocked
                      ? typeof modelData === "string"
                        ? modelData
                        : JSON.stringify(modelData)
                      : result.displayText;
                  const metadata =
                    result.success && result.data && typeof result.data === "object"
                      ? (result.data as Record<string, unknown> | Array<Record<string, unknown>>)
                      : undefined;
                  return { data, displayText: result.displayText, metadata };
                }
              : undefined;

            stream = ReasoningService.processTextStreamingCloud(llmMessages, {
              systemPrompt,
              tools: registry?.getAll().map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
              executeToolCall,
              ...(cloudScreenContext ? { screenContext: cloudScreenContext } : {}),
            });
          } else {
            const registryTools = registry?.toAISDKFormat(
              (toolCallId, abortSignal) =>
                toolScope.createContext({
                  messageId: assistantId,
                  toolCallId,
                  signal: abortSignal,
                }),
              (id, text) => toolDisplayTexts.set(id, text)
            );
            const aiTools = writeOnceGuard
              ? prepareVoiceTools(registryTools, {
                  dryRunNames,
                  guard: writeOnceGuard,
                  onBlockedRepeat: (callId) => blockedRepeatCallIds.add(callId),
                })
              : registryTools;
            stream = ReasoningService.processTextStreamingAI(
              llmMessages,
              llmConfig.model,
              llmConfig.provider,
              {
                systemPrompt,
                // Policy and managed enforcement judge the scope that actually
                // answers: the panel's Chat fallback as Chat, and the vision
                // override as the agent scope whose image lane it is.
                inferenceScope:
                  llmConfig.scope === "dictationAgentVision" ? "dictationAgent" : llmConfig.scope,
                lanUrl: isLanAgent ? llmConfig.remoteUrl : undefined,
                baseUrl: isCustomAgent ? llmConfig.cloudBaseUrl || undefined : undefined,
                customApiKey:
                  isCustomAgent || isLanAgent ? llmConfig.customApiKey || undefined : undefined,
                disableThinking: llmConfig.disableThinking,
                ...(voiceTurn && isLocalProvider
                  ? { maxTokens: VOICE_LOCAL_MAX_OUTPUT_TOKENS }
                  : {}),
              },
              aiTools
            );
          }

          for await (const chunk of stream) {
            if (!mountedRef.current) {
              ReasoningService.cancelActiveStream();
              break;
            }
            if (chunk.type === "content") {
              if (chunk.text) announceResponse();
              fullContent += chunk.text;
              // A barge-in cancelled this answer; its late chunks belong to no turn.
              if (chunk.text && !cancelled()) voiceTap?.onContentDelta(chunk.text);
              scheduleContentFlush();
            } else if (chunk.type === "tool_calls") {
              // Text that arrived before a tool step must be on screen before the
              // step appears, not an interval after it.
              flushContentNow();
              if (chunk.calls.length > 0) announceResponse();
              if (voiceTap && chunk.calls.length > 0 && !cancelled()) {
                voiceTap.onToolCall(chunk.calls.map((call) => call.name));
              }
              for (const call of chunk.calls) {
                setAgentState("tool-executing");
                beginToolActivity(
                  call.name,
                  t(`agentMode.tools.${call.name}Status`, { defaultValue: `Using ${call.name}...` })
                );
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? {
                          ...m,
                          toolCalls: [
                            ...(m.toolCalls || []),
                            {
                              id: call.id,
                              name: call.name,
                              arguments: call.arguments,
                              status: "executing" as const,
                            },
                          ],
                        }
                      : m
                  )
                );
              }
            } else if (chunk.type === "tool_result") {
              const blockedRepeat = blockedRepeatCallIds.has(chunk.callId);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId && m.toolCalls
                    ? {
                        ...m,
                        toolCalls: blockedRepeat
                          ? m.toolCalls.filter((tc) => tc.id !== chunk.callId)
                          : m.toolCalls.map((tc) =>
                              tc.id === chunk.callId
                                ? {
                                    ...tc,
                                    status: "completed" as const,
                                    result: toolDisplayTexts.get(chunk.callId) ?? chunk.displayText,
                                    ...(chunk.metadata ? { metadata: chunk.metadata } : {}),
                                  }
                                : tc
                            ),
                      }
                    : m
                )
              );
              setAgentState("streaming");
              completeToolActivity();
            }
          }

          if (cancelled() || !mountedRef.current) {
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
            // An unmount mid-stream (page navigation) keeps the partial reply in
            // history so the saved conversation matches what the user last saw;
            // an explicit cancel drops it. The unmount cleanup cancels too, so
            // cancelled() alone cannot tell the two apart. Neither path may run
            // the per-request delivery hook.
            const explicitlyCancelled = explicitCancelGenerationRef.current > sendGeneration;
            if (!explicitlyCancelled && fullContent.trim().length > 0) {
              const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
              onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
              voiceTap?.onResponseDone();
            }
            return;
          }

          flushContentNow();
          const hasDeliverableContent = fullContent.trim().length > 0;
          if (!responseAnnounced && !cancelled()) {
            // The stream ended without a visible token or tool call (think-only
            // local model, empty completion). Show that as a reply so every
            // listener — the assistant panel's thinking state included — sees a
            // terminal outcome.
            fullContent = t("agentMode.chat.emptyResponse");
            announceResponse();
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          }

          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
          );

          const finalMsg = messagesRef.current.find((m) => m.id === assistantId);
          onStreamComplete?.(assistantId, fullContent, finalMsg?.toolCalls);
          voiceTap?.onResponseDone();
          if (hasDeliverableContent) {
            await options?.onComplete?.({
              assistantId,
              content: fullContent,
              toolCalls: finalMsg?.toolCalls,
            });
          }
        } catch (error) {
          if (cancelled()) {
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
          } else {
            cancelContentFlush();
            logger.error(
              "Assistant request failed",
              {
                scope: llmConfig.scope,
                mode: llmMode,
                provider: llmConfig.provider,
                model: llmConfig.model,
                attachScreenContext,
                error: (error as Error).message,
              },
              "reasoning"
            );
            announceResponse();
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: `${t("agentMode.chat.errorPrefix")}: ${(error as Error).message}`,
                      isStreaming: false,
                    }
                  : m
              )
            );
            voiceTap?.onResponseDone();
          }
        }

        setAgentState("idle");
        completeToolActivity();
      }
    },
    [
      inferenceScope,
      allowConnectors,
      t,
      setMessages,
      onStreamComplete,
      onResponseContent,
      clearToolActivity,
      beginToolActivity,
      completeToolActivity,
    ]
  );

  return {
    agentState,
    toolStatus,
    activeToolName,
    sendToAI,
    cancelStream,
  };
}
