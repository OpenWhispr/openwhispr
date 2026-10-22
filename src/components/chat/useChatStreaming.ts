import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReasoningService, { type AgentStreamChunk } from "../../services/ReasoningService";
import { getCloudModel, isEnterpriseProvider } from "../../models/ModelRegistry";
import { providerSupportsImages } from "../../services/ai/inferenceProviders";
import { getSettings, selectCalendarConnected, useSettingsStore } from "../../stores/settingsStore";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import { describeProviderError } from "../../utils/describeProviderError";
import { productHelpMetadata } from "../../services/help/productHelp";
import logger from "../../utils/logger";
import {
  isAgentAllowed,
  isConnectorsAllowed,
  isConnectorsBlockedByOrg,
  isLlmSelectionAllowed,
  isScreenContextAllowed,
  isWebSearchAllowed,
  isWebSearchBlockedByOrg,
} from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import { useAuth } from "../../hooks/useAuth";
import { getUsageState } from "../../lib/usageStore";
import { readIsSubscribed } from "../../lib/subscriptionFlag";
import { hasConnectorPlan } from "../../utils/connectorEligibility";
import { gmailSendStatus, resolveEmailDraftTarget } from "../../utils/emailDraftTarget";
import {
  ensureConnectorStatus,
  readyConnectorIds,
  useConnectorStatusStore,
} from "../../stores/connectorStatusStore";
import {
  appendDictionarySuffix,
  appendScreenContextSuffix,
  getAgentSystemPrompt,
} from "../../config/prompts";
import { calendarProviders, resolveUnavailableCapabilities } from "../../config/agentCapabilities";
import { getDictionaryHintWords } from "../../utils/snippets";
import { noteAttendeesContext, withoutAttendeesFence } from "../../utils/noteAttendees";
import { FULL_TRANSCRIPT_MAX_TOKENS } from "../../utils/transcriptEvidence";
import { createToolRegistry } from "../../services/tools";
import { executeTool, type ToolRegistry } from "../../services/tools/ToolRegistry";
import { createToolExecutionScope, type ToolExecutionScope } from "./toolExecutionScope";
import { isQueryResultData } from "../../services/tools/connectors/runQueryAction";
import type { InteractionToolOptions } from "../../services/tools/interactionTools";
import { API_KEY_PROVIDERS } from "../../stores/agentInteractionStore";
import { getAgentToolActivityRemainingMs } from "../../helpers/agentToolPresentation";
import type { ChatInferenceScope, ConnectionTarget } from "../../types/agentInteractions";
import type {
  Message,
  MessageError,
  AgentState,
  AssistantTurn,
  ChatImageAttachment,
  ToolCallInfo,
} from "./types";
import {
  connectsFirst,
  toHistoryMessages,
  withoutEchoedToolTrace,
  type HistoryMessage,
} from "./historyMessages";
import type { ContainerScope } from "../../types/chat";
import type { NoteAttendeesRequest } from "../../types/connectors";
import {
  buildAgentRequestText,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";

const RAG_NOTE_LIMIT = 5;
const RAG_NOTE_SNIPPET_LENGTH = 500;
const STREAM_FLUSH_INTERVAL_MS = 32;
const MAX_SAVED_REASONING_CHARS = 20_000;

const LOCAL_TOOL_MIN_PARAMS_B = 4;

function estimateModelSizeB(modelId: string): number {
  const match = modelId.match(/-([\d.]+)[bB]/);
  return match ? parseFloat(match[1]) : 0;
}

const CONNECTOR_CONNECTION_TARGETS = ["gmail", "slack", "linear", "github"] as const;

// What the user can connect from the chat: connectors this build can connect
// that aren't ready, and a calendar while none is connected.
function connectionTargets(
  statuses: Record<string, { connected: boolean; configured: boolean; needsReconnect: boolean }>,
  {
    connectorsAvailable,
    calendarConnected,
  }: { connectorsAvailable: boolean; calendarConnected: boolean }
): ConnectionTarget[] {
  const targets: ConnectionTarget[] = connectorsAvailable
    ? CONNECTOR_CONNECTION_TARGETS.filter((id) => {
        const status = statuses[id];
        return (
          status && status.configured !== false && (!status.connected || status.needsReconnect)
        );
      })
    : [];
  if (!calendarConnected) {
    targets.push("calendar", ...calendarProviders());
  }
  return targets;
}

// The sends this conversation already made, from the tool calls it saved.
function completedActionKeys(messages: ReadonlyArray<Message>): string[] {
  return messages.flatMap((message) =>
    (message.toolCalls ?? []).flatMap((call) => (call.actionKey ? [call.actionKey] : []))
  );
}

// Main adds the note's identified speakers and its calendar event's
// organizer (calendars often leave them out of the attendees), then drops
// the user (their OpenWhispr address included) and rooms with find_contact's
// rules; a failed lookup just leaves the block out.
async function buildNoteAttendeesContext(
  meeting: NoteAttendeesRequest | undefined
): Promise<string> {
  if (!meeting || !window.electronAPI?.connectorNoteAttendees) return "";
  try {
    const result = await window.electronAPI.connectorNoteAttendees(meeting);
    return noteAttendeesContext(result?.attendees ?? []);
  } catch {
    return "";
  }
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

export interface OpenNoteContext {
  text: string;
  /** Only the start of the transcript is included; get_note reads the rest. */
  transcriptPreview: boolean;
}

interface UseChatStreamingOptions {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  /**
   * Settings scope the conversation resolves its provider and model from. Typed
   * chat surfaces stay on the Chat scope; the agent window runs on the Voice
   * Assistant scope, so the model picked under Settings > Voice Assistant
   * answers (see resolveChatStreamingInference for its Chat fallback).
   */
  inferenceScope?: ChatInferenceScope;
  /** Notes listed in the system prompt as possibly relevant (container overview chat). */
  noteContext?: string;
  /**
   * The note a note's chat is about. The model answers from it first, and no
   * other notes are added up front: it reaches them through search_notes.
   */
  openNote?: string | ((maxTranscriptTokens: number) => OpenNoteContext);
  /** Optional container scope applied to RAG and the search_notes tool (container overview chat). */
  searchScope?: ContainerScope;
  /**
   * The agent chat: offer the interaction tools (questions, connect cards,
   * access, keys, settings), show and save each turn's notes (status, timing,
   * reasoning), and keep a stopped reply. Only on surfaces that render them;
   * other chats show and save replies as they always have.
   */
  allowInteractions?: boolean;
  /**
   * Offer connector tools (email drafts, contact lookup) when the plan and
   * policy allow them. Off unless a surface opts in: they act outside the app.
   */
  allowConnectors?: boolean;
  /**
   * Name capabilities that exist but aren't usable here, and how to turn them
   * on. Off only where the request already says what to do without them (the
   * onboarding demo answers with suggested times instead).
   */
  nameUnavailableCapabilities?: boolean;
  /** Disable product-help tools on guided surfaces such as the onboarding demo. */
  productHelpEnabled?: boolean;
  /**
   * The note's meeting (note chat). Its attendees are listed for the model
   * only in a send that offers connector tools, so recipients come from them.
   */
  noteMeeting?: NoteAttendeesRequest;
  onStreamComplete?: TurnHandler;
  /**
   * Saves a turn that is still running: when it starts or stops waiting on the
   * user (a question survives the app closing, an answered one isn't offered
   * again), and when a send lands after it stopped.
   */
  onTurnCheckpoint?: TurnHandler;
}

/** What a saved turn needs besides its text and tool calls. */
export interface TurnDetails {
  /** Agent chat only (allowInteractions). */
  turn?: AssistantTurn;
  /** The conversation the turn ran in, so a turn that ends after a switch saves there. */
  conversationId?: number;
}

export type TurnHandler = (
  assistantId: string,
  content: string,
  toolCalls: ToolCallInfo[] | undefined,
  details: TurnDetails
) => void;

export interface SendToAIOptions {
  /** The conversation this turn is saved into. */
  conversationId?: number;
  /** Screenshot for this message; attached only when the resolved model can see it. */
  attachment?: ChatImageAttachment;
  /** The selected text this request is about; saved with the user message and quoted again later. */
  selectedContext?: AgentSelectionContext;
  /**
   * Sent to the model in place of this turn's visible message, which is what the
   * chat shows and saves (a note action shows its name while its prompt is sent).
   */
  requestText?: string;
  /** This turn isn't offered update_note, so it can't change a note (a note's chat action). */
  keepNotesUnchanged?: boolean;
  /** Per-request completion hook used to deliver a finished voice response. */
  onComplete?: (result: {
    assistantId: string;
    content: string;
    toolCalls?: ToolCallInfo[];
  }) => void | Promise<void>;
  /**
   * Regenerates this reply in place (same message, same saved row) instead of
   * adding one. The sends it made stay on it: the conversation never forgets them.
   */
  replaceMessage?: Message;
  /** A regenerate that failed before anything new: its old reply is back, and the caller can say so. */
  onReplaceFailed?: () => void;
}

export interface ChatStreaming {
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  sendToAI: (userText: string, allMessages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancelStream: () => void;
}

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
  setMessages,
  inferenceScope = "chatIntelligence",
  noteContext: externalNoteContext,
  openNote,
  searchScope,
  allowInteractions = false,
  allowConnectors = false,
  nameUnavailableCapabilities = true,
  productHelpEnabled = true,
  noteMeeting,
  onStreamComplete,
  onTurnCheckpoint,
}: UseChatStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");
  const mountedRef = useRef(true);
  const noteContextRef = useRef(externalNoteContext);
  noteContextRef.current = externalNoteContext;
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  const searchScopeRef = useRef(searchScope);
  searchScopeRef.current = searchScope;
  const noteMeetingRef = useRef(noteMeeting);
  noteMeetingRef.current = noteMeeting;
  // Only an account bound to this session: after a switch, drafts must not
  // be signed with the previous account's name.
  const { user } = useAuth();
  const userNameRef = useRef<string | null>(null);
  userNameRef.current = user?.name ?? null;
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
      // Filled in once the reply exists; a tool may report before then.
      const turnHooks: {
        annotate?: (toolCallId: string, patch: Partial<ToolCallInfo>) => void;
      } = {};
      const stepImages: ChatImageAttachment[] = [];
      const toolScope = createToolExecutionScope({
        onInteraction: ({ toolCallId, record }) =>
          turnHooks.annotate?.(toolCallId, { interaction: record }),
        onImageAttached: (image) => stepImages.push(image),
        onActionCompleted: ({ toolCallId, actionKey }) =>
          turnHooks.annotate?.(toolCallId, { actionKey }),
        completedActions: completedActionKeys(
          options?.replaceMessage ? [...allMessages, options.replaceMessage] : allMessages
        ),
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
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: restriction,
              isStreaming: false,
            },
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
        const policy = usePolicyStore.getState();
        const calendarConnected = selectCalendarConnected(settings);
        const webSearchEnabled = isWebSearchAllowed(policy);
        const connectorPlan = hasConnectorPlan(getUsageState(), readIsSubscribed());
        let registry: ToolRegistry | null = null;
        let connectorsOffered = false;
        let interactions: InteractionToolOptions | undefined;
        if (supportsTools) {
          const scopeKey = scope ? `${scope.spaceId}:${scope.folderId ?? ""}` : "";
          const connectorsAvailable =
            allowConnectors && settings.isSignedIn && connectorPlan && isConnectorsAllowed(policy);
          // The first send in a window must not miss a connector that is already connected.
          if (connectorsAvailable) await ensureConnectorStatus();
          const currentEmailDraftTarget = () =>
            resolveEmailDraftTarget({
              ...getSettings(),
              gmailStatus: gmailSendStatus(useConnectorStatusStore.getState().statuses.gmail),
            });
          interactions = allowInteractions
            ? {
                connectionTargets: connectionTargets(useConnectorStatusStore.getState().statuses, {
                  connectorsAvailable,
                  calendarConnected,
                }),
                missingKeyProviders: API_KEY_PROVIDERS.filter(
                  (provider) => !settings[`${provider}ApiKey`]
                ),
                // A screenshot reaches a BYOK model that can see; Cloud's chat
                // path doesn't route images yet.
                screenAccess:
                  !isCloudAgent &&
                  isScreenContextAllowed(policy) &&
                  providerSupportsImages(llmConfig.provider) &&
                  !!getCloudModel(llmConfig.model, llmConfig.provider)?.supportsVision,
                inferenceScope,
              }
            : undefined;
          const connectors = connectorsAvailable
            ? {
                emailDraftTarget: currentEmailDraftTarget(),
                readyConnectorIds: readyConnectorIds(),
                ...(interactions
                  ? {
                      asksUser: true,
                      connectableConnectorIds: interactions.connectionTargets,
                      ...(interactions.connectionTargets.includes("gmail")
                        ? { currentEmailDraftTarget }
                        : {}),
                    }
                  : {}),
              }
            : undefined;
          connectorsOffered = connectors !== undefined;
          // Triggers ride in the tool description, so a snippet edit rebuilds the registry.
          const snippetKey = settings.snippets.map((s) => s.trigger).join("|");
          const keepNotesUnchanged = !!options?.keepNotesUnchanged;
          const interactionKey = interactions
            ? `${interactions.connectionTargets.join(",")}/${interactions.missingKeyProviders.join(",")}/${interactions.screenAccess}`
            : "no-interactions";
          const cacheKey = `${settings.isSignedIn}-${calendarConnected}-${settings.cloudBackupEnabled}-${scopeKey}-${webSearchEnabled}-${productHelpEnabled}-${snippetKey}-${connectors?.emailDraftTarget ?? "no-connectors"}-${connectors?.readyConnectorIds.join(",") ?? ""}-${keepNotesUnchanged}-${interactionKey}`;
          if (toolRegistryRef.current?.key === cacheKey) {
            registry = toolRegistryRef.current.registry;
          } else {
            registry = createToolRegistry({
              isSignedIn: settings.isSignedIn,
              calendarConnected,
              cloudBackupEnabled: settings.cloudBackupEnabled,
              searchScope: scope,
              webSearchEnabled,
              productHelpEnabled,
              vocabulary: {
                getDictionary: () => getSettings().customDictionary,
                updateDictionary: (changes) =>
                  useSettingsStore.getState().updateCustomDictionary(changes),
                getSnippets: () => getSettings().snippets,
                setSnippets: (snippets) => useSettingsStore.getState().setSnippets(snippets),
              },
              connectors,
              keepNotesUnchanged,
              interactions,
            });
            toolRegistryRef.current = { key: cacheKey, registry };
          }
        }

        // Named in the prompt so the model says how to turn a capability on
        // instead of claiming it can't; built per send, outside the registry cache.
        const unavailable = resolveUnavailableCapabilities({
          supportsTools,
          isSignedIn: settings.isSignedIn,
          webSearch: { allowed: webSearchEnabled, blockedByOrg: isWebSearchBlockedByOrg(policy) },
          calendarConnected,
          connectors: allowConnectors
            ? {
                hasPlan: connectorPlan,
                allowed: isConnectorsAllowed(policy),
                blockedByOrg: isConnectorsBlockedByOrg(policy),
                statuses: useConnectorStatusStore.getState().statuses,
              }
            : undefined,
          locations: {
            account: `${t("sidebar.settings")} → ${t("settingsModal.sections.account.label")}`,
            plans: `${t("sidebar.settings")} → ${t("settingsModal.sections.plansBilling.label")}`,
            calendars: `${t("sidebar.integrations")} → ${t("integrations.nav.sections.calendars")}`,
            connectors: `${t("sidebar.integrations")} → ${t("integrations.nav.sections.connectors")}`,
            models: `${t("sidebar.settings")} → ${t("settingsModal.sections.llms.label")}`,
          },
          connectionTargets: interactions?.connectionTargets,
        });

        // A note's chat is about its note: other notes up front would compete with
        // it, and search_notes still reaches them when it doesn't answer.
        const [ragContext, attendeesContext] = await Promise.all([
          openNoteRef.current ? "" : buildRAGContext(userText, scope),
          connectorsOffered ? buildNoteAttendeesContext(noteMeetingRef.current) : "",
        ]);
        if (cancelled() || !mountedRef.current) return;
        // A transcript too long for the model is read through get_note, except
        // by whole-note actions, which work from the complete source.
        const maxTranscriptTokens =
          registry?.get("get_note") && !options?.requestText
            ? FULL_TRANSCRIPT_MAX_TOKENS[
                !isCloudAgent && (isLocalProvider || isLanAgent) ? "selfHosted" : "hosted"
              ]
            : Infinity;
        const currentNote: OpenNoteContext =
          typeof openNoteRef.current === "function"
            ? openNoteRef.current(maxTranscriptTokens)
            : { text: openNoteRef.current ?? "", transcriptPreview: false };
        // Only main's attendee block may carry its fence: note text and search
        // results can't fake a second list.
        const openNoteContext = [withoutAttendeesFence(currentNote.text), attendeesContext]
          .filter(Boolean)
          .join("\n\n");
        const libraryContext = [
          withoutAttendeesFence(noteContextRef.current ?? ""),
          withoutAttendeesFence(ragContext),
        ]
          .filter(Boolean)
          .join("\n\n");
        // The user's dictionary rides on every conversation so replies use their
        // jargon — same suffix the dictation prompts carry.
        let systemPrompt = appendDictionarySuffix(
          getAgentSystemPrompt(registry?.getAll(), libraryContext || undefined, {
            unavailable: nameUnavailableCapabilities ? unavailable : [],
            toolTrace: registry !== null,
            openNote: openNoteContext || undefined,
            openNoteTranscriptPreview: currentNote.transcriptPreview,
            userName: userNameRef.current,
            writingStyle: settings.toneStyleEnabled ? { tones: settings.toneStyles } : undefined,
          }),
          getDictionaryHintWords(settings),
          settings.uiLanguage
        );

        const history: HistoryMessage[] = toHistoryMessages(allMessages, {
          includeToolTrace: registry !== null,
        });

        const requestText = options?.requestText;
        if (requestText) {
          transformLastUserMessage(history, (message) => ({ ...message, content: requestText }));
        }

        // A saved user message keeps its selected text, and toHistoryMessages adds it.
        const selectedContext = options?.selectedContext;
        const lastUserMessage = allMessages.filter((message) => message.role === "user").at(-1);
        if (selectedContext && !lastUserMessage?.selectedContext) {
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

        const replaced = options?.replaceMessage;
        const assistantId = replaced?.id ?? crypto.randomUUID();
        let turn: AssistantTurn = { startedAt: Date.now(), status: "running" };
        let toolCalls: ToolCallInfo[] = replaced?.toolCalls?.filter((call) => call.actionKey) ?? [];
        const carriedCallCount = toolCalls.length;
        let reasoning = "";
        let rawContent = "";
        let fullContent = "";
        // A tool may report before the stream shows its call (it can ask the
        // user at once), so what it reports waits here for the call.
        const annotations = new Map<string, Partial<ToolCallInfo>>();
        const currentTurn = (): AssistantTurn | undefined => {
          if (!allowInteractions) return undefined;
          if (!reasoning) return turn;
          // Saved again at every checkpoint, so a long one is cut.
          return {
            ...turn,
            reasoning:
              reasoning.length > MAX_SAVED_REASONING_CHARS
                ? `${reasoning.slice(0, MAX_SAVED_REASONING_CHARS)}…`
                : reasoning,
          };
        };
        const currentToolCalls = (): ToolCallInfo[] | undefined =>
          toolCalls.length > 0 ? toolCalls : undefined;
        const turnDetails = (): TurnDetails => ({
          turn: currentTurn(),
          ...(options?.conversationId != null ? { conversationId: options.conversationId } : {}),
        });
        const hasPendingInteraction = (): boolean =>
          toolCalls.some((call) => call.interaction?.state === "pending");

        const placeholder: Message = {
          id: assistantId,
          role: "assistant",
          content: "",
          isStreaming: true,
          toolCalls: currentToolCalls(),
          turn: currentTurn(),
        };
        setMessages((prev) =>
          replaced
            ? prev.map((m) => (m.id === assistantId ? { ...placeholder, dbId: m.dbId } : m))
            : [...prev, placeholder]
        );
        setAgentState("streaming");

        // Chat re-parses the whole answer through react-markdown on every
        // content write, so one write per streamed token made parse cost scale
        // with token count. Buffer and flush at most once per interval.
        let contentFlushTimer: ReturnType<typeof setTimeout> | null = null;
        const cancelContentFlush = () => {
          if (contentFlushTimer === null) return;
          clearTimeout(contentFlushTimer);
          contentFlushTimer = null;
        };
        const flushContentNow = () => {
          cancelContentFlush();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: fullContent, toolCalls: currentToolCalls(), turn: currentTurn() }
                : m
            )
          );
        };
        const scheduleContentFlush = () => {
          if (contentFlushTimer !== null) return;
          contentFlushTimer = setTimeout(flushContentNow, STREAM_FLUSH_INTERVAL_MS);
        };

        const checkpoint = () =>
          onTurnCheckpoint?.(assistantId, fullContent, currentToolCalls(), turnDetails());
        const updateWaiting = () => {
          const waiting = hasPendingInteraction();
          const saves = waiting || turn.status === "waiting";
          if (saves) turn = { ...turn, status: waiting ? "waiting" : "running" };
          flushContentNow();
          if (saves) checkpoint();
        };
        const saveReply = () =>
          onStreamComplete?.(assistantId, fullContent, currentToolCalls(), turnDetails());
        turnHooks.annotate = (toolCallId, patch) => {
          annotations.set(toolCallId, { ...annotations.get(toolCallId), ...patch });
          if (!toolCalls.some((call) => call.id === toolCallId)) return;
          toolCalls = toolCalls.map((call) =>
            call.id === toolCallId ? { ...call, ...patch } : call
          );
          if (patch.interaction) updateWaiting();
          else flushContentNow();
          // Saved at once, so a renderer that dies before the turn ends (or a
          // card that commits after Stop) can't lose a send.
          if (patch.actionKey) checkpoint();
        };

        // A stop keeps what the reply has so far, and every call still running
        // ends with it. Questions it was waiting on are dismissed by Esc or
        // Stop; an unmount leaves them to answer later. A tool still waiting
        // for its service to connect never ran.
        const settleStoppedTurn = (explicit: boolean) => {
          const waiting = hasPendingInteraction();
          toolCalls = toolCalls.map((call) => {
            if (call.status !== "executing") return call;
            if (call.interaction?.state !== "pending") return { ...call, status: "stopped" };
            return {
              ...call,
              status: "stopped",
              ...(connectsFirst(call) ? { metadata: { status: "not_sent" } } : {}),
              interaction: explicit
                ? { ...call.interaction, state: "settled", result: { status: "cancelled" } }
                : { ...call.interaction, state: "interrupted" },
            };
          });
          turn = {
            ...turn,
            finishedAt: Date.now(),
            status: waiting && !explicit ? "interrupted" : "stopped",
          };
        };

        // A regenerate stopped or failed before it had anything new shows (and
        // keeps) the reply it was replacing, not an empty one.
        const restoresReplaced = () =>
          Boolean(replaced) && !fullContent.trim() && toolCalls.length === carriedCallCount;
        const restoreReplaced = () => {
          if (!replaced) return;
          cancelContentFlush();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...replaced, isStreaming: false } : m))
          );
        };

        // A call that ran into a step boundary starts the next text (and the
        // next reasoning) on a new paragraph.
        let afterToolCall = false;
        let reasoningAfterToolCall = false;
        let stepLimitReached = false;

        try {
          let stream: AsyncGenerator<AgentStreamChunk>;
          // Each call's own step text on the AI SDK path, whose tool results
          // carry only the model-facing output (the cloud path yields it).
          const toolDisplayTexts = new Map<string, string>();

          if (isCloudAgent) {
            const executeToolCall = registry
              ? async (name: string, argsJson: string, toolCallId: string) => {
                  const tool = registry.get(name);
                  if (!tool)
                    return {
                      data: `Unknown tool: ${name}`,
                      displayText: t("agentMode.tools.unknownTool", { name }),
                      isError: true,
                    };
                  let args: Record<string, unknown>;
                  try {
                    args = JSON.parse(argsJson);
                  } catch {
                    return {
                      data: `Invalid tool arguments for ${name}`,
                      displayText: t("agentMode.tools.invalidArgs", { name }),
                      isError: true,
                    };
                  }
                  const result = await executeTool(
                    tool,
                    args,
                    toolScope.createContext({ messageId: assistantId, toolCallId })
                  );
                  const data = result.success
                    ? typeof result.data === "string"
                      ? result.data
                      : JSON.stringify(result.data)
                    : result.displayText;
                  const metadata =
                    result.success && result.data && typeof result.data === "object"
                      ? (result.data as Record<string, unknown> | Array<Record<string, unknown>>)
                      : undefined;
                  return {
                    data,
                    displayText: result.displayText,
                    metadata,
                    isError: !result.success,
                  };
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
            const aiTools = registry?.toAISDKFormat(
              (toolCallId, abortSignal) =>
                toolScope.createContext({
                  messageId: assistantId,
                  toolCallId,
                  signal: abortSignal,
                }),
              (id, text) => toolDisplayTexts.set(id, text)
            );
            stream = ReasoningService.processTextStreamingAI(
              llmMessages,
              llmConfig.model,
              llmConfig.provider,
              {
                systemPrompt,
                // Policy and managed enforcement judge the scope that actually
                // answers: the agent window's Chat fallback as Chat, and the vision
                // override as the agent scope whose image lane it is.
                inferenceScope:
                  llmConfig.scope === "dictationAgentVision" ? "dictationAgent" : llmConfig.scope,
                lanUrl: isLanAgent ? llmConfig.remoteUrl : undefined,
                baseUrl: isCustomAgent ? llmConfig.cloudBaseUrl || undefined : undefined,
                customApiKey:
                  isCustomAgent || isLanAgent ? llmConfig.customApiKey || undefined : undefined,
                disableThinking: llmConfig.disableThinking,
                reasoningEffort: llmConfig.reasoningEffort,
                stepImages,
              },
              aiTools
            );
          }

          for await (const chunk of stream) {
            if (!mountedRef.current) {
              ReasoningService.cancelActiveStream();
              break;
            }
            // Nothing a cancelled turn streams afterwards is shown or kept.
            if (cancelled()) break;
            if (chunk.type === "content") {
              if (afterToolCall && rawContent && !/\s$/.test(rawContent)) rawContent += "\n\n";
              afterToolCall = false;
              rawContent += chunk.text;
              fullContent = withoutEchoedToolTrace(rawContent);
              scheduleContentFlush();
            } else if (chunk.type === "reasoning") {
              if (reasoningAfterToolCall && reasoning && !/\s$/.test(reasoning))
                reasoning += "\n\n";
              reasoningAfterToolCall = false;
              reasoning += chunk.text;
              scheduleContentFlush();
            } else if (chunk.type === "tool_calls") {
              afterToolCall = true;
              reasoningAfterToolCall = true;
              // Text that arrived before a tool step must be on screen before the
              // step appears, not an interval after it.
              flushContentNow();
              for (const call of chunk.calls) {
                setAgentState("tool-executing");
                beginToolActivity(
                  call.name,
                  t(`agentMode.tools.${call.name}Status`, { defaultValue: `Using ${call.name}...` })
                );
                toolCalls = [
                  ...toolCalls,
                  {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    status: "executing",
                    startedAt: Date.now(),
                    ...annotations.get(call.id),
                  },
                ];
              }
              if (chunk.calls.some((call) => annotations.get(call.id)?.interaction)) {
                updateWaiting();
              } else {
                flushContentNow();
              }
            } else if (chunk.type === "tool_result") {
              toolCalls = toolCalls.map((tc) =>
                tc.id === chunk.callId
                  ? {
                      ...tc,
                      status: chunk.isError ? ("error" as const) : ("completed" as const),
                      finishedAt: Date.now(),
                      result: toolDisplayTexts.get(chunk.callId) ?? chunk.displayText,
                      ...(chunk.metadata && !isQueryResultData(chunk.metadata)
                        ? {
                            metadata:
                              productHelpMetadata(tc.name, chunk.metadata) ?? chunk.metadata,
                          }
                        : {}),
                    }
                  : tc
              );
              flushContentNow();
              setAgentState("streaming");
              completeToolActivity();
            } else if (chunk.type === "done") {
              stepLimitReached = chunk.finishReason === "tool-calls";
            }
          }

          if (cancelled() || !mountedRef.current) {
            // An unmount mid-stream (page navigation) keeps the partial reply in
            // history so the saved conversation matches what the user last saw.
            // The agent chat also keeps a reply stopped by Esc, Stop or a switch
            // to another chat, with what its tools did and the questions it was
            // waiting on; elsewhere an explicit cancel drops it. The unmount
            // cleanup cancels too, so cancelled() alone cannot tell the two
            // apart. Neither path may run the per-request delivery hook.
            const explicitlyCancelled = explicitCancelGenerationRef.current > sendGeneration;
            if (restoresReplaced()) {
              restoreReplaced();
              return;
            }
            settleStoppedTurn(explicitlyCancelled);
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
            const keepsReply = allowInteractions
              ? fullContent.trim().length > 0 || toolCalls.length > 0
              : !explicitlyCancelled && fullContent.trim().length > 0;
            if (keepsReply) saveReply();
            return;
          }

          const hasDeliverableContent = fullContent.trim().length > 0;
          // Visible text or a tool call of this stream; one with neither still ends in a reply.
          const responseShown = Boolean(fullContent) || toolCalls.length > carriedCallCount;
          if (!responseShown) {
            // The stream ended without a visible token or tool call (think-only
            // local model, empty completion). Show that as a reply so every
            // listener — the agent window's thinking state included — sees a
            // terminal outcome.
            fullContent = t("agentMode.chat.emptyResponse");
          }

          turn = {
            ...turn,
            finishedAt: Date.now(),
            status: stepLimitReached ? "step_limit" : "complete",
          };
          flushContentNow();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
          );

          saveReply();
          if (hasDeliverableContent) {
            await options?.onComplete?.({
              assistantId,
              content: fullContent,
              toolCalls: currentToolCalls(),
            });
          }
        } catch (error) {
          if (!cancelled()) {
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
          }
          if (restoresReplaced()) {
            restoreReplaced();
            if (!cancelled()) options?.onReplaceFailed?.();
          } else if (cancelled()) {
            settleStoppedTurn(explicitCancelGenerationRef.current > sendGeneration);
            flushContentNow();
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, isStreaming: false } : message
              )
            );
          } else {
            cancelContentFlush();
            const failure = describeProviderError(error, t);
            // Set on every failed reply: the chat then knows the failure is on screen.
            const messageError: MessageError = {
              ...(failure.technicalDetails ? { technicalDetails: failure.technicalDetails } : {}),
              ...(failure.settingsTarget ? { settingsTarget: failure.settingsTarget } : {}),
            };
            settleStoppedTurn(true);
            turn = { ...turn, status: "error" };
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      content: `${t("agentMode.chat.errorPrefix")}: ${failure.description}`,
                      isStreaming: false,
                      toolCalls: currentToolCalls(),
                      turn: currentTurn(),
                      error: messageError,
                    }
                  : m
              )
            );
            // A failed reply is shown, not saved, unless its tools already
            // acted: the agent chat must remember what they did.
            if (allowInteractions && toolCalls.length > 0) saveReply();
          }
        }

        setAgentState("idle");
        completeToolActivity();
      }
    },
    [
      inferenceScope,
      allowConnectors,
      allowInteractions,
      nameUnavailableCapabilities,
      productHelpEnabled,
      t,
      setMessages,
      onStreamComplete,
      onTurnCheckpoint,
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
