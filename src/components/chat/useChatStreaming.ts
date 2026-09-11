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
  isLlmSelectionAllowed,
  isWebSearchAllowed,
} from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import {
  appendDictionarySuffix,
  appendScreenContextSuffix,
  getAgentSystemPrompt,
} from "../../config/prompts";
import { getDictionaryHintWords } from "../../utils/snippets";
import { createToolRegistry } from "../../services/tools";
import type { ToolRegistry } from "../../services/tools/ToolRegistry";
import { getAgentToolActivityRemainingMs } from "../../helpers/agentToolPresentation";
import type { Message, AgentState, ChatImageAttachment, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";
import {
  buildAgentRequestText,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";

const RAG_NOTE_LIMIT = 5;
const RAG_NOTE_SNIPPET_LENGTH = 500;

const LOCAL_TOOL_MIN_PARAMS_B = 4;

function estimateModelSizeB(modelId: string): number {
  const match = modelId.match(/-([\d.]+)[bB]/);
  return match ? parseFloat(match[1]) : 0;
}

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
  onStreamComplete?: (assistantId: string, content: string, toolCalls?: ToolCallInfo[]) => void;
  /** Fires exactly once when displayable assistant content or tool activity becomes available. */
  onResponseContent?: () => void;
}

export interface SendToAIOptions {
  /** Screenshot for this message; attached only when the resolved model can see it. */
  attachment?: ChatImageAttachment;
  /** Agent-response selection attached to this request without changing chat history. */
  selectedContext?: AgentSelectionContext;
  /** Keeps a caret-destined voice response in the compact pill while it streams. */
  suppressResponseContent?: boolean;
  /** Per-request completion hook used to deliver a finished voice response. */
  onComplete?: (result: {
    assistantId: string;
    content: string;
    toolCalls?: ToolCallInfo[];
  }) => void | Promise<void>;
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
  onStreamComplete,
  onResponseContent,
}: UseChatStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
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
  const cancelStream = useCallback(() => {
    sendGenerationRef.current += 1;
    if (mountedRef.current) {
      explicitCancelGenerationRef.current = sendGenerationRef.current;
    }
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
      clearToolActivity();
      let responseAnnounced = false;
      const announceResponse = () => {
        if (responseAnnounced) return;
        responseAnnounced = true;
        if (!options?.suppressResponseContent) onResponseContent?.();
      };
      const settings = getSettings();
      const { config: llmConfig, attachScreenContext } = resolveChatStreamingInference(settings, {
        inferenceScope,
        hasScreenContext: !!options?.attachment,
        isProviderImageWired: providerSupportsImages,
      });
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
          { id: crypto.randomUUID(), role: "assistant", content: restriction, isStreaming: false },
        ]);
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
        // Triggers ride in the tool description, so a snippet edit rebuilds the registry.
        const snippetKey = settings.snippets.map((s) => s.trigger).join("|");
        const cacheKey = `${settings.isSignedIn}-${calendarConnected}-${settings.cloudBackupEnabled}-${scopeKey}-${webSearchEnabled}-${snippetKey}`;
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
          });
          toolRegistryRef.current = { key: cacheKey, registry };
        }
      }

      const ragContext = await buildRAGContext(userText, scope);
      if (cancelled() || !mountedRef.current) return;
      const combinedContext = [noteContextRef.current, ragContext].filter(Boolean).join("\n\n");
      // The user's dictionary rides on every conversation so replies use their
      // jargon — same suffix the dictation prompts carry.
      let systemPrompt = appendDictionarySuffix(
        getAgentSystemPrompt(
          registry?.getAll().map((t) => t.name),
          combinedContext || undefined
        ),
        getDictionaryHintWords(settings),
        settings.uiLanguage
      );

      const history: HistoryMessage[] = allMessages
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

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

      try {
        let fullContent = "";
        let stream: AsyncGenerator<AgentStreamChunk>;

        if (isCloudAgent) {
          const executeToolCall = registry
            ? async (name: string, argsJson: string) => {
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
                const result = await tool.execute(args);
                const data = result.success
                  ? typeof result.data === "string"
                    ? result.data
                    : JSON.stringify(result.data)
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
          const aiTools = registry?.toAISDKFormat();
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
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: fullContent } : m))
            );
          } else if (chunk.type === "tool_calls") {
            if (chunk.calls.length > 0) announceResponse();
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
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId && m.toolCalls
                  ? {
                      ...m,
                      toolCalls: m.toolCalls.map((tc) =>
                        tc.id === chunk.callId
                          ? {
                              ...tc,
                              status: "completed" as const,
                              result: chunk.displayText,
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
          }
          return;
        }

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
        if (hasDeliverableContent) {
          await options?.onComplete?.({
            assistantId,
            content: fullContent,
            toolCalls: finalMsg?.toolCalls,
          });
        }
      } catch (error) {
        if (cancelled()) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId ? { ...message, isStreaming: false } : message
            )
          );
        } else {
          logger.error(
            "Assistant request failed",
            {
              scope: llmConfig.scope,
              mode: llmMode,
              provider: llmConfig.provider,
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
        }
      }

      setAgentState("idle");
      completeToolActivity();
    },
    [
      inferenceScope,
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
