import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReasoningService, { type AgentStreamChunk } from "../../services/ReasoningService";
import { getCloudModel, isEnterpriseProvider } from "../../models/ModelRegistry";
import { PROVIDER_REGISTRY } from "../../services/ai/inferenceProviders";
import { getSettings, selectResolvedLLMConfig } from "../../stores/settingsStore";
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

interface UseChatStreamingOptions {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
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

// An image attaches only where the provider's AI-SDK client is image-wired
// (registry `supportsImages`) AND the model id exists in the local registry,
// so supportsVision is decidable — the same dual gate the single-shot
// dictation path applies. OpenRouter/custom alias the OpenAI client here, but
// their model ids never appear in the registry (vision would be a guess that
// errors the whole command on a text-only backend). The cloud path carries its
// screenshot separately as a server-routed field below.
const providerSupportsStreamImages = (providerId: string) =>
  Boolean(providerId && PROVIDER_REGISTRY[providerId]?.supportsImages);

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
      const chatConfig = selectResolvedLLMConfig(settings, "chatIntelligence");
      const chatAgentMode = chatConfig.mode || "openwhispr";
      const policyState = usePolicyStore.getState();
      const policyProvider =
        chatAgentMode === "openwhispr"
          ? "openwhispr"
          : chatAgentMode === "local"
            ? "local"
            : chatConfig.provider;
      if (
        !isAgentAllowed(policyState) ||
        !isLlmSelectionAllowed(policyState, { mode: chatAgentMode, provider: policyProvider })
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
      const isCloudAgent = chatAgentMode === "openwhispr" && settings.isSignedIn;
      const isLanAgent = chatAgentMode === "self-hosted" && !!chatConfig.remoteUrl;
      const isCustomAgent = chatAgentMode === "providers" && chatConfig.provider === "custom";
      const isLocalProvider =
        !isEnterpriseProvider(chatConfig.provider) &&
        ![
          "openai",
          "groq",
          "custom",
          "anthropic",
          "gemini",
          "tinfoil",
          "openrouter",
          "corti",
        ].includes(chatConfig.provider);
      const localModelCanUseTool =
        isLocalProvider && estimateModelSizeB(chatConfig.model) >= LOCAL_TOOL_MIN_PARAMS_B;
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
        const cacheKey = `${settings.isSignedIn}-${calendarConnected}-${settings.cloudBackupEnabled}-${scopeKey}-${webSearchEnabled}`;
        if (toolRegistryRef.current?.key === cacheKey) {
          registry = toolRegistryRef.current.registry;
        } else {
          registry = createToolRegistry({
            isSignedIn: settings.isSignedIn,
            calendarConnected,
            cloudBackupEnabled: settings.cloudBackupEnabled,
            searchScope: scope,
            webSearchEnabled,
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

      // Attach the screenshot to the command it came with, but only where a
      // model can actually see it; otherwise drop it silently — an image
      // problem must never cost the user their command. BYOK models get it as
      // an image part when the registry says they have vision; the cloud
      // agent gets it as a dedicated field the server vision-routes (older
      // servers strip the unknown field, which degrades to a plain command).
      const attachment =
        options?.attachment &&
        !isCloudAgent &&
        !isLanAgent &&
        !isLocalProvider &&
        providerSupportsStreamImages(chatConfig.provider) &&
        getCloudModel(chatConfig.model)?.supportsVision
          ? options.attachment
          : null;
      const cloudScreenContext =
        options?.attachment && isCloudAgent
          ? { data: options.attachment.image, mediaType: options.attachment.mediaType }
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
            chatConfig.model,
            chatConfig.provider,
            {
              systemPrompt,
              inferenceScope: "chatIntelligence",
              lanUrl: isLanAgent ? chatConfig.remoteUrl : undefined,
              baseUrl: isCustomAgent ? chatConfig.cloudBaseUrl || undefined : undefined,
              customApiKey:
                isCustomAgent || isLanAgent ? chatConfig.customApiKey || undefined : undefined,
              disableThinking: chatConfig.disableThinking,
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
