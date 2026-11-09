import i18n from "../../i18n";
import ReasoningService, { type AgentStreamChunk } from "../../services/ReasoningService";
import {
  getCloudModel,
  getLocalModel,
  getProviderDisplayName,
  isEnterpriseProvider,
} from "../../models/ModelRegistry";
import { providerSupportsImages } from "../../services/ai/inferenceProviders";
import { getSettings, selectCalendarConnected, useSettingsStore } from "../../stores/settingsStore";
import { resolveChatStreamingInference } from "../../helpers/dictationAgentInference.js";
import { describeProviderError } from "../../utils/describeProviderError";
import {
  asProviderError,
  providerError,
  PROVIDER_ERROR_CODES,
  redactProviderBody,
} from "../../helpers/providerHttpErrors.js";
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
  localChoiceRefusal,
} from "../../stores/policyRules";
import { usePolicyStore } from "../../stores/policyStore";
import { readSkillCardRecord, SKILL_CARD_TOOLS } from "./skillCardRecord";
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
  buildMessageContext,
  getAgentSystemPrompt,
  getSpokenReplyRule,
} from "../../config/prompts";
import {
  CONNECTOR_NAMES,
  calendarProviders,
  resolveUnavailableCapabilities,
} from "../../config/agentCapabilities";
import { refreshSkills, useSkillsStore } from "../../stores/skillsStore";
import { estimateNoteTokens } from "../../helpers/noteChunking";
import {
  SKILL_CATALOG_MAX_TOKENS,
  SKILL_CONTEXT_MAX_TOKENS,
  activeSkillNames,
  buildCreatorContext,
  buildSkillBlock,
  buildSkillCatalog,
  fitSkillBlock,
  skillNotUsedNote,
  withSkillContext,
} from "../../utils/skillContext";
import { pickSkillForRequest } from "../../utils/localSkillPick";
import type { SkillRef, SkillSummary } from "../../types/skills";
import { getLlmDictionaryWords } from "../../utils/snippets";
import { noteAttendeesContext, withoutAttendeesFence } from "../../utils/noteAttendees";
import { FULL_TRANSCRIPT_MAX_TOKENS } from "../../utils/transcriptEvidence";
import { createToolRegistry } from "../../services/tools";
import { adaptToolsForVoice } from "../../services/voice/voiceToolPolicy";
import type { SpokenLanguage } from "../../services/voice/types";
import {
  createLookAtScreenTool,
  LOOK_AT_SCREEN_PROMPT,
} from "../../services/tools/lookAtScreenTool";
import type { SharedDictionaryWord } from "../../services/tools/dictionaryTool";
import { setSharedWordsHidden } from "../../services/sharedDictionaryActions";
import { readActiveWorkspaceId } from "../../stores/workspaceStore";
import { selectAppliedSharedWords } from "../../utils/sharedDictionaryHints";
import { executeTool, type ToolRegistry, type ToolResult } from "../../services/tools/ToolRegistry";
import { createToolExecutionScope, type ToolExecutionScope } from "./toolExecutionScope";
import { isQueryResultData } from "../../services/tools/connectors/runQueryAction";
import type { InteractionToolOptions } from "../../services/tools/interactionTools";
import { isApiKeySetupAllowed } from "../../helpers/agentApiKeyPolicy";
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
import { isPendingAssistantModelDownloading } from "../onboarding/pendingLocalModels";
import {
  connectsFirst,
  HISTORY_MAX_TOKENS,
  toHistoryMessages,
  withoutEchoedToolTrace,
  type HistoryMessage,
  type ToolHistory,
} from "./historyMessages";
import { isUnbackedClaim } from "./actionClaims";
import type { ContainerScope } from "../../types/chat";
import type { NoteAttendeesRequest } from "../../types/connectors";
import type { ConversationClaim } from "./useChatPersistence";
import {
  buildAgentRequestText,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";

const RAG_NOTE_LIMIT = 5;
const RAG_NOTE_SNIPPET_LENGTH = 500;
const STREAM_FLUSH_INTERVAL_MS = 32;
const MAX_SAVED_REASONING_CHARS = 20_000;

const LOCAL_TOOL_MIN_PARAMS_B = 4;

// The tool reads the DB mirror over IPC (not the control panel's store), so it
// also works from the dictation window, for the workspace every window uses now.
async function readAppliedSharedWords(): Promise<SharedDictionaryWord[]> {
  const workspaceId = readActiveWorkspaceId();
  if (!workspaceId) return [];
  try {
    const snapshot = await window.electronAPI?.getSharedDictionary?.(workspaceId);
    if (!snapshot) return [];
    return selectAppliedSharedWords(snapshot, getSettings());
  } catch (error) {
    // The assistant then treats shared words as absent rather than failing the call.
    logger.warn(
      "Failed to read the shared dictionary for the assistant",
      { error: (error as Error)?.message },
      "dictionary"
    );
    return [];
  }
}

async function hideAppliedSharedWords(ids: string[]): Promise<void> {
  const workspaceId = readActiveWorkspaceId();
  if (!workspaceId) throw new Error("No active workspace");
  await setSharedWordsHidden(workspaceId, ids, true);
}

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
        const content = [
          note.enhanced_content?.slice(0, RAG_NOTE_SNIPPET_LENGTH),
          note.content?.slice(0, RAG_NOTE_SNIPPET_LENGTH),
        ]
          .filter(Boolean)
          .join("\n\n");
        return JSON.stringify({ id: note.id, title: note.title, content });
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

export interface ChatTurnOptions {
  userName: string | null;
  isOwnerCurrent?: () => boolean;
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
  /** The user's skills reach the model. Off unless a surface opts in. */
  skillsEnabled?: boolean;
  /**
   * The note's meeting (note chat). Its attendees are listed for the model
   * only in a send that offers connector tools, so recipients come from them.
   */
  noteMeeting?: NoteAttendeesRequest;
  onStreamComplete?: TurnHandler;
  /**
   * Takes the conversation for this window while a turn runs in it, so another
   * window shows it without running or answering it; the latest messages come
   * with a claim this window didn't hold yet. False when another window has it.
   */
  claimConversation?: (id: number) => Promise<false | ConversationClaim>;
  /**
   * Saves a turn that is still running: before it streams, when it starts or
   * stops waiting on the user (a question survives the app closing, an
   * answered one isn't offered again), and when a send lands after it stopped.
   */
  onTurnCheckpoint?: TurnHandler;
}

/** What a saved turn needs besides its text and tool calls. */
export interface TurnDetails {
  /** Agent chat only (allowInteractions). */
  turn?: AssistantTurn;
  /** The conversation the turn ran in, so a turn that ends after a switch saves there. */
  conversationId?: number;
  /** The saved row a regenerated reply replaces: it's completed there even once New chat cleared it. */
  rowId?: number;
}

export type TurnHandler = (
  assistantId: string,
  content: string,
  toolCalls: ToolCallInfo[] | undefined,
  details: TurnDetails
) => void | Promise<void>;

/** How a spoken request's turn ended, for the voice call that hears it. */
export type TurnSpeechOutcome = "complete" | "refused" | "error" | "stopped";

/**
 * Hears one spoken request's reply as it streams, so a voice call can speak it.
 * Called only for the send it was given to, and onEnd exactly once.
 */
export interface TurnSpeechObserver {
  /**
   * New reply text. `isUnbacked` is the claim check the reply will face: text
   * it flags may be withdrawn, so it isn't spoken until the turn shows it stands.
   */
  onText: (delta: string, isUnbacked?: (text: string) => boolean) => void;
  /**
   * Text was withdrawn (an unbacked claim asked again, or a failure replacing
   * the reply): the reply now keeps only its first `keptLength` characters.
   */
  onTextWithdrawn: (keptLength: number) => void;
  /** The model called these tools. */
  onToolCalls: (toolNames: string[]) => void;
  /** The tools this turn offers, once (the voice harness scores against them). */
  onToolsOffered?: (toolNames: string[]) => void;
  /** A write tool ran (a repeat the write-once guard blocked never does): whether it succeeded. */
  onWriteRun?: (toolName: string, ok: boolean) => void;
  onEnd: (outcome: TurnSpeechOutcome) => void;
}

export interface SendToAIOptions {
  /** The conversation this turn is saved into. */
  conversationId?: number;
  /** Saves this send after its originating view changes. */
  persistAssistantMessage?: TurnHandler;
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
  /** A skill the user attached to this chat; its text joins the model-only copy of this turn. */
  attachedSkill?: SkillRef;
  /** False once the user removed an app-picked skill from this chat. */
  allowSkillPick?: boolean;
  /** Skills the user took off this chat; they stay off even where the history loaded them. */
  removedSkills?: string[];
  /** The app picked a skill for a model without tools; the surface shows its chip. */
  onSkillPicked?: (skill: { name: string; displayName: string }) => void;
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
  /**
   * A request spoken in a voice call: the reply is written to be read aloud in
   * `replyLanguage` (null: the language spoken), and `speech` hears it stream.
   * `dryRunWrites` (the voice harness) runs no write tool. `interrupts`: it was
   * said over a turn still running, so that turn's request may be its start.
   */
  voice?: {
    replyLanguage: SpokenLanguage | null;
    speech: TurnSpeechObserver;
    dryRunWrites?: boolean;
    interrupts?: boolean;
  };
}

// A reply stopped before it said or did anything.
function stoppedBeforeReply(message: Message | undefined): boolean {
  return (
    message?.role === "assistant" &&
    message.turn?.status === "stopped" &&
    !message.content.trim() &&
    !message.toolCalls?.length
  );
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

export interface ChatTurnSink {
  setMessages: (update: (messages: Message[]) => Message[]) => void;
  setAgentState: (state: AgentState) => void;
  setToolStatus: (status: string) => void;
  setActiveToolName: (name: string) => void;
}

export interface ChatTurnEngine {
  send: (text: string, messages: Message[], options?: SendToAIOptions) => Promise<void>;
  cancel: (options: { explicit: boolean }) => void;
}

interface TurnControl {
  controller: AbortController;
  explicit: boolean;
  scope: ToolExecutionScope;
  clearTimers: () => void;
}

export function createChatTurnEngine(
  getOptions: () => ChatTurnOptions,
  sink: ChatTurnSink
): ChatTurnEngine {
  let current: TurnControl | null = null;
  // Sends started, and stops issued: a send still waiting for its conversation
  // gives way to a newer send, and doesn't start after a stop.
  let latestSend = 0;
  let stops = 0;
  const ownerCurrent = (): boolean => getOptions().isOwnerCurrent?.() ?? true;
  const cancel = ({ explicit }: { explicit: boolean }): void => {
    stops += 1;
    if (!current) return;
    // Leaving after Stop must not turn a discarded answer back into one worth saving.
    current.explicit ||= explicit;
    current.controller.abort();
    current.scope.abort();
    current.clearTimers();
    if (ownerCurrent()) {
      sink.setAgentState("idle");
      sink.setToolStatus("");
      sink.setActiveToolName("");
    }
  };
  const send = async (
    userText: string,
    allMessages: Message[],
    options?: SendToAIOptions
  ): Promise<void> => {
    cancel({ explicit: true });
    const speech = options?.voice?.speech;
    let speechOutcome: TurnSpeechOutcome = "stopped";
    const sendNumber = ++latestSend;
    const stopsAtStart = stops;
    const { claimConversation } = getOptions();
    const claim =
      options?.conversationId != null && claimConversation
        ? await claimConversation(options.conversationId)
        : undefined;
    if (claim === false) {
      options?.onReplaceFailed?.();
      speech?.onEnd("refused");
      return;
    }
    if (sendNumber !== latestSend || stops !== stopsAtStart) {
      // A newer send holds the same claim now, and gives it back when it ends.
      if (sendNumber === latestSend) await claim?.release();
      speech?.onEnd("stopped");
      return;
    }
    // A claim this window didn't hold brings the conversation as it is saved now.
    if (claim?.messages) {
      if (options?.replaceMessage) {
        const latest = claim.messages.at(-1);
        if (latest?.dbId !== options.replaceMessage.dbId || latest?.role !== "assistant") {
          options.onReplaceFailed?.();
          speech?.onEnd("refused");
          await claim.release();
          return;
        }
        options = { ...options, replaceMessage: latest };
        allMessages = claim.messages.slice(0, -1);
        userText =
          [...allMessages].reverse().find((message) => message.role === "user")?.content ??
          userText;
      } else allMessages = claim.messages;
    }
    // Filled in once the reply exists; a tool may report before then.
    const turnHooks: {
      annotate?: (toolCallId: string, patch: Partial<ToolCallInfo>) => void;
    } = {};
    const stepImages: ChatImageAttachment[] = [];
    const toolScope = createToolExecutionScope({
      onInteraction: ({ toolCallId, record }) =>
        turnHooks.annotate?.(toolCallId, { interaction: record }),
      onImageAttached: (image) => stepImages.push(image),
      onActionCompleted: ({ toolCallId, actionKey, outcome }) =>
        turnHooks.annotate?.(toolCallId, {
          actionKey,
          ...(outcome
            ? { metadata: { ...outcome }, status: "completed", finishedAt: Date.now() }
            : {}),
        }),
      completedActions: completedActionKeys(
        options?.replaceMessage ? [...allMessages, options.replaceMessage] : allMessages
      ),
    });
    let flushPendingContent = (): void => {};
    let toolTimer: ReturnType<typeof setTimeout> | null = null;
    let activityStarted: number | null = null;
    const clearTimers = (): void => {
      flushPendingContent();
      if (toolTimer !== null) clearTimeout(toolTimer);
      toolTimer = null;
    };
    const control: TurnControl = {
      controller: new AbortController(),
      explicit: false,
      scope: toolScope,
      clearTimers,
    };
    current = control;
    const isCurrent = (): boolean => current === control && ownerCurrent();
    const cancelled = (): boolean => control.controller.signal.aborted || !ownerCurrent();
    const setMessages: ChatTurnSink["setMessages"] = (update) => {
      if (isCurrent()) sink.setMessages(update);
    };
    const setAgentState: ChatTurnSink["setAgentState"] = (state) => {
      if (isCurrent()) sink.setAgentState(state);
    };
    const clearToolActivity = (): void => {
      if (toolTimer !== null) clearTimeout(toolTimer);
      toolTimer = null;
      activityStarted = null;
      if (isCurrent()) {
        sink.setToolStatus("");
        sink.setActiveToolName("");
      }
    };
    const beginToolActivity = (name: string, status: string): void => {
      clearToolActivity();
      activityStarted = Date.now();
      if (isCurrent()) {
        sink.setToolStatus(status);
        sink.setActiveToolName(name);
      }
    };
    const completeToolActivity = (): void => {
      if (!isCurrent() || cancelled()) return;
      const remaining =
        activityStarted === null ? 0 : getAgentToolActivityRemainingMs(activityStarted);
      if (toolTimer !== null) clearTimeout(toolTimer);
      if (!remaining) clearToolActivity();
      else toolTimer = setTimeout(clearToolActivity, remaining);
    };
    const {
      inferenceScope = "chatIntelligence",
      allowInteractions = false,
      allowConnectors = false,
      nameUnavailableCapabilities = true,
      productHelpEnabled = true,
      skillsEnabled = false,
      onStreamComplete,
      onTurnCheckpoint,
    } = getOptions();
    const t = i18n.t.bind(i18n);
    let carriedSkillNames: ReadonlySet<string> = new Set();
    try {
      if (!cancelled()) await runSend();
    } finally {
      speech?.onEnd(speechOutcome);
      toolScope.abort();
      flushPendingContent();
      setAgentState("idle");
      if (cancelled() || !isCurrent()) clearTimers();
      if (claim && sendNumber === latestSend) await claim.release();
    }
    async function runSend(): Promise<void> {
      // Answers the already-appended user message with one line instead of a dead end.
      const answerWithLine = (content: string, error?: Message["error"]): void => {
        if (!cancelled()) {
          speech?.onText(content);
          speechOutcome = "refused";
        }
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content,
            isStreaming: false,
            ...(error ? { error } : {}),
          },
        ]);
      };
      const currentOpenNote = getOptions().openNote;
      const settings = getSettings();
      const { config: llmConfig, attachScreenContext } = resolveChatStreamingInference(settings, {
        inferenceScope,
        hasScreenContext: !!options?.attachment,
        isProviderImageWired: providerSupportsImages,
      });
      const requestedAttachment =
        attachScreenContext && isScreenContextAllowed(usePolicyStore.getState())
          ? (options?.attachment ?? null)
          : null;
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
        !isLlmSelectionAllowed(policyState, {
          mode: llmMode,
          provider: policyProvider,
          model: llmConfig.model,
        })
      ) {
        const agentAllowed = isAgentAllowed(policyState);
        const refusal =
          agentAllowed && llmMode === "local" ? localChoiceRefusal(policyState, "llm") : null;
        answerWithLine(
          !agentAllowed
            ? t("common.policyAgentRestricted")
            : t(refusal?.messageKey ?? "common.policyAiProcessingRestricted"),
          refusal ? { settingsTarget: refusal.settingsTarget } : undefined
        );
        return;
      }

      // Local mode with no model picked (e.g. the assistant was switched off
      // at setup): nothing on this device can answer, and Cloud is not the
      // fallback. Say where to pick one, or that the model is on its way.
      if (llmMode === "local" && !llmConfig.model.trim()) {
        const downloading = await isPendingAssistantModelDownloading();
        if (cancelled()) return;
        answerWithLine(t(downloading ? "chat.localModelDownloading" : "chat.localModelMissing"));
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
      // The catalog's supportsTools decides; the size guess covers models without it.
      const localModelCanUseTool =
        isLocalProvider &&
        (getLocalModel(llmConfig.model)?.supportsTools ??
          estimateModelSizeB(llmConfig.model) >= LOCAL_TOOL_MIN_PARAMS_B);
      const supportsTools = isCloudAgent || !isLocalProvider || localModelCanUseTool;
      // A local or LAN model may have a 16k context; hosted models have room to spare.
      const contextTier =
        !isCloudAgent && (isLocalProvider || isLanAgent) ? "selfHosted" : "hosted";

      let usableSkills: SkillSummary[] = [];
      // The skills this chat may use: the user's, less those taken off it. The creator still
      // hears of every skill, so it doesn't propose one the user already has.
      let offeredSkills: SkillSummary[] = [];
      const removedSkills = new Set(options?.removedSkills);
      let activeRefs: SkillRef[] = skillsEnabled
        ? activeSkillNames(allMessages, options?.attachedSkill).filter(
            (ref) => ref.builtin || !removedSkills.has(ref.name)
          )
        : [];
      if (skillsEnabled) {
        // Read fresh: a skill switched off or edited since the last send is never offered.
        await refreshSkills();
        usableSkills = useSkillsStore
          .getState()
          .skills.filter((skill) => skill.enabled && skill.valid);
        offeredSkills = usableSkills.filter((skill) => !removedSkills.has(skill.name));
      }

      const scope = getOptions().searchScope;
      const policy = usePolicyStore.getState();
      const calendarConnected = selectCalendarConnected(settings);
      const webSearchEnabled = isWebSearchAllowed(policy);
      const connectorPlan = hasConnectorPlan(getUsageState(), readIsSubscribed());
      const connectorsAvailable =
        allowConnectors && settings.isSignedIn && connectorPlan && isConnectorsAllowed(policy);
      let registry: ToolRegistry | null = null;
      let connectorsOffered = false;
      let interactions: InteractionToolOptions | undefined;
      if (supportsTools) {
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
                (provider) =>
                  !settings[`${provider}ApiKey`] && isApiKeySetupAllowed(provider, inferenceScope)
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
        const creatorAttached = Boolean(options?.attachedSkill?.builtin);
        const keepNotesUnchanged = !!options?.keepNotesUnchanged;
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
            getSharedWords: readAppliedSharedWords,
            hideSharedWords: hideAppliedSharedWords,
            getSnippets: () => getSettings().snippets,
            setSnippets: (snippets) => useSettingsStore.getState().setSnippets(snippets),
          },
          connectors,
          keepNotesUnchanged,
          keepSnippetsUnchanged: Boolean(options?.voice),
          interactions,
          skills: skillsEnabled
            ? {
                usable: offeredSkills,
                activeNames: () => carriedSkillNames,
                read: (ref) =>
                  window.electronAPI?.skillsReadForModel?.(ref) ?? Promise.resolve(null),
                // Last use only orders the catalog; a failed stamp isn't worth surfacing.
                markUsed: (name) => void window.electronAPI?.skillsMarkUsed?.(name).catch(() => {}),
                maxTokens: SKILL_CONTEXT_MAX_TOKENS[contextTier],
                creatorAttached,
              }
            : undefined,
        });
        if (options?.voice) {
          adaptToolsForVoice(registry, {
            dryRunWrites: options.voice.dryRunWrites,
            onWriteRun: options.voice.speech.onWriteRun,
          });
        }
      }

      // Named in the prompt so the model says how to turn a capability on
      // instead of claiming it can't; built for this send.
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

      // The text of the skills this conversation uses (the attached one, and those loaded
      // in the history the model sees) rides only in the model's copy of this turn, rebuilt
      // on every send, so the chat and its saved history keep just what the user typed.
      // A model without tools can't load a skill, so the app picks at most one for it.
      const picked =
        skillsEnabled &&
        registry === null &&
        !options?.attachedSkill &&
        options?.allowSkillPick !== false
          ? pickSkillForRequest(userText, offeredSkills)
          : null;
      if (picked) {
        activeRefs = [
          { name: picked.name },
          ...activeRefs.filter((ref) => ref.builtin || ref.name !== picked.name),
        ];
      }
      const skillBlocks: string[] = [];
      const carried = new Set<string>();
      let skillRoom: number = SKILL_CONTEXT_MAX_TOKENS[contextTier];
      for (const ref of activeRefs) {
        // A skill switched off, broken or unreadable since it was attached or loaded is left
        // out, and the turn still goes. The attached one's chip still shows, so the model is
        // told it isn't used, to say so.
        const leftOut = (): void => {
          if (ref === options?.attachedSkill) skillBlocks.push(skillNotUsedNote(ref.name));
        };
        if (!ref.builtin && !usableSkills.some((skill) => skill.name === ref.name)) {
          leftOut();
          continue;
        }
        const skill = await window.electronAPI
          ?.skillsReadForModel?.({ ...ref, withFiles: registry === null })
          .catch(() => null);
        if (!skill) {
          leftOut();
          continue;
        }
        const connectedApps = connectorsAvailable
          ? readyConnectorIds().map((id) => CONNECTOR_NAMES[id] ?? id)
          : [];
        const creatorContext = ref.builtin
          ? `\n${buildCreatorContext(usableSkills, connectedApps, {
              canUseTools: registry !== null,
              maxTokens: SKILL_CATALOG_MAX_TOKENS[contextTier],
              opening: t("skills.chat.creatorOpening"),
            })}`
          : "";
        const blockOptions = { inlineFiles: registry === null };
        const { text: fitted, cut } = fitSkillBlock(
          skill,
          skillRoom - estimateNoteTokens(creatorContext),
          blockOptions
        );
        const whole = !cut;
        // The first skill had all the room load_skill has, so even cut it is as much of it as
        // the model can get. A later one was cut by the skills before it: a model with tools
        // reads it with load_skill, which gives it that whole room.
        const first = skillBlocks.length === 0;
        if (!whole && registry !== null && !first) continue;
        const block = fitted + creatorContext;
        skillRoom -= estimateNoteTokens(block);
        skillBlocks.push(block);
        // A carried skill is "already loaded" for load_skill, which would only send it again;
        // without tools there is no load_skill, and what's carried is what the picked chip names.
        if (!ref.builtin && (whole || first || registry === null)) carried.add(ref.name);
        if (skillRoom <= 0) break;
      }
      if (cancelled()) return;
      carriedSkillNames = carried;
      if (picked && carried.has(picked.name)) {
        options?.onSkillPicked?.({ name: picked.name, displayName: picked.displayName });
      }

      // A note's chat is about its note: other notes up front would compete with
      // it, and search_notes still reaches them when it doesn't answer.
      const [ragContext, attendeesContext] = await Promise.all([
        currentOpenNote ? "" : buildRAGContext(userText, scope),
        connectorsOffered ? buildNoteAttendeesContext(getOptions().noteMeeting) : "",
      ]);
      if (cancelled()) return;
      // A transcript too long for the model is read through get_note, except
      // by whole-note actions, which work from the complete source.
      const maxTranscriptTokens =
        registry?.get("get_note") && !options?.requestText
          ? FULL_TRANSCRIPT_MAX_TOKENS[contextTier]
          : Infinity;
      const currentNote: OpenNoteContext =
        typeof currentOpenNote === "function"
          ? currentOpenNote(maxTranscriptTokens)
          : { text: currentOpenNote ?? "", transcriptPreview: false };
      // Only main's attendee block may carry its fence: note text and search
      // results can't fake a second list.
      const openNoteContext = [withoutAttendeesFence(currentNote.text), attendeesContext]
        .filter(Boolean)
        .join("\n\n");
      const libraryContext = [
        withoutAttendeesFence(getOptions().noteContext ?? ""),
        withoutAttendeesFence(ragContext),
      ]
        .filter(Boolean)
        .join("\n\n");
      // Earlier tool use replays as tool messages, except to self-hosted
      // servers, whose chat templates may not take them: they get a note.
      const toolHistory: ToolHistory =
        registry === null
          ? "none"
          : !isCloudAgent && (isLocalProvider || isLanAgent || isCustomAgent)
            ? "text"
            : "parts";
      // In the agent window, a Cloud screenshot is read through look_at_screen
      // instead of riding with the request: the API sends any request with an
      // image to its vision model, so small talk would switch models and see
      // the screen.
      const cloudScreen =
        requestedAttachment && isCloudAgent
          ? { data: requestedAttachment.image, mediaType: requestedAttachment.mediaType }
          : null;
      const lookAtScreen =
        cloudScreen && registry && allowInteractions
          ? createLookAtScreenTool((question) =>
              ReasoningService.askAboutScreen(
                question,
                cloudScreen,
                LOOK_AT_SCREEN_PROMPT,
                toolScope.signal
              )
            )
          : null;
      const offeredTools = registry
        ? [...registry.getAll(), ...(lookAtScreen ? [lookAtScreen] : [])]
        : undefined;
      speech?.onToolsOffered?.(offeredTools?.map((tool) => tool.name) ?? []);
      // The user's dictionary rides on every conversation so replies use their
      // jargon — same suffix the dictation prompts carry.
      let systemPrompt = appendDictionarySuffix(
        getAgentSystemPrompt(offeredTools, {
          unavailable: nameUnavailableCapabilities ? unavailable : [],
          ...(toolHistory !== "none" ? { toolHistory } : {}),
          openNote: openNoteContext || undefined,
          openNoteTranscriptPreview: currentNote.transcriptPreview,
          userName: getOptions().userName,
          writingStyle: settings.toneStyleEnabled ? { tones: settings.toneStyles } : undefined,
          skillCatalog: registry?.get("load_skill")
            ? buildSkillCatalog(offeredSkills, SKILL_CATALOG_MAX_TOKENS[contextTier])
            : undefined,
          skillContent: skillBlocks.length > 0,
        }),
        getLlmDictionaryWords(settings, { includeTriggers: true }),
        settings.uiLanguage
      );
      if (options?.voice) {
        systemPrompt += `\n\n${getSpokenReplyRule(options.voice.replyLanguage)}`;
      }

      // A whole-note action asks with its own text in place of the saved
      // request; swapped before the history is built, so a note the history
      // opens the request with (sends it left out) stays.
      const requestText = options?.requestText;
      // A spoken request leaves out those the user stopped before any reply (End,
      // Stop, a stop word): read beside it, one was answered as if asked again.
      // The one it talked over stays, as it may be this request's start; typed
      // chat keeps them all, noted.
      const roles = allMessages.map((message) => message.role);
      const talkedOver = options?.voice?.interrupts
        ? roles.lastIndexOf("user", roles.length - 2)
        : -1;
      const asked = options?.voice
        ? allMessages.filter(
            (message, i) =>
              message.role !== "user" || i === talkedOver || !stoppedBeforeReply(allMessages[i + 1])
          )
        : allMessages;
      const requestIndex = asked.map((message) => message.role).lastIndexOf("user");
      const history: HistoryMessage[] = toHistoryMessages(
        requestText
          ? asked.map((message, i) =>
              i === requestIndex ? { ...message, content: requestText } : message
            )
          : asked,
        {
          toolHistory,
          isOffered: (name) => offeredTools?.some((tool) => tool.name === name) ?? false,
          maxTokens: HISTORY_MAX_TOKENS[contextTier],
        }
      );

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

      if (skillBlocks.length > 0) {
        transformLastUserMessage(history, (message) =>
          typeof message.content === "string"
            ? { ...message, content: withSkillContext(message.content, skillBlocks) }
            : null
        );
      }
      // The time and the matching notes change with every message, so they
      // ride on it: the system prompt, tools and earlier turns stay cacheable.
      transformLastUserMessage(history, (message) =>
        typeof message.content === "string"
          ? {
              ...message,
              content: `${message.content}\n\n${buildMessageContext(libraryContext || undefined)}`,
            }
          : message
      );

      // A screenshot the resolver kept rides with the command it came with:
      // BYOK models get it as an image part, the cloud agent (outside the
      // agent window's look_at_screen) as a dedicated field the server
      // vision-routes. A dropped one costs nothing but the image — the
      // command still runs.
      const attachment = requestedAttachment && !isCloudAgent ? requestedAttachment : null;
      const cloudScreenContext = lookAtScreen ? null : cloudScreen;
      if (requestedAttachment && !lookAtScreen) {
        // Either way it needs its grounding instruction, as the dictation path
        // pairs the suffix with an attached image.
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
      // Providers can reuse an earlier request's IDs; its receipts keep their own.
      const carriedCallIds = new Map(toolCalls.map((call) => [call.id, crypto.randomUUID()]));
      const currentToolCallId = (id: string): string => carriedCallIds.get(id) ?? id;
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
              ? `${reasoning.slice(0, MAX_SAVED_REASONING_CHARS).replace(/[\uD800-\uDBFF]$/u, "")}…`
              : reasoning,
        };
      };
      const currentToolCalls = (): ToolCallInfo[] | undefined =>
        toolCalls.length > 0 ? toolCalls : undefined;
      const turnDetails = (): TurnDetails => ({
        turn: currentTurn(),
        ...(options?.conversationId != null ? { conversationId: options.conversationId } : {}),
        ...(replaced?.dbId != null ? { rowId: replaced.dbId } : {}),
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
      const cancelContentFlush = (): void => {
        if (contentFlushTimer === null) return;
        clearTimeout(contentFlushTimer);
        contentFlushTimer = null;
      };
      const flushContentNow = (): void => {
        cancelContentFlush();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: fullContent, toolCalls: currentToolCalls(), turn: currentTurn() }
              : m
          )
        );
      };
      // Stop shows the text that had arrived, as the stopped reply saves it.
      flushPendingContent = (): void => {
        if (contentFlushTimer !== null) flushContentNow();
      };
      const scheduleContentFlush = (): void => {
        if (contentFlushTimer !== null) return;
        contentFlushTimer = setTimeout(flushContentNow, STREAM_FLUSH_INTERVAL_MS);
      };

      // Account changes and deletion fence every write, even one that reports after Stop.
      const save = (
        handler: TurnHandler | undefined,
        content = fullContent
      ): void | Promise<void> =>
        ownerCurrent()
          ? handler?.(assistantId, content, currentToolCalls(), turnDetails())
          : undefined;
      // Only the agent chat saves a turn while it runs; a per-send save elsewhere
      // waits for the reply.
      const checkpointHandler =
        (allowInteractions ? options?.persistAssistantMessage : undefined) ?? onTurnCheckpoint;
      const checkpoint = (): void | Promise<void> => save(checkpointHandler);
      const saveReply = (): void | Promise<void> =>
        save(options?.persistAssistantMessage ?? onStreamComplete);
      const updateWaiting = (): void => {
        const waiting = hasPendingInteraction();
        const saves = waiting || turn.status === "waiting";
        if (saves) turn = { ...turn, status: waiting ? "waiting" : "running" };
        flushContentNow();
        if (saves) checkpoint();
      };
      turnHooks.annotate = (toolCallId, patch) => {
        if (!ownerCurrent()) return;
        annotations.set(toolCallId, { ...annotations.get(toolCallId), ...patch });
        if (!toolCalls.some((call) => call.id === toolCallId)) return;
        toolCalls = toolCalls.map((call) =>
          call.id === toolCallId ? { ...call, ...patch } : call
        );
        if (patch.interaction) updateWaiting();
        else if (turn.status === "running" || turn.status === "waiting") flushContentNow();
        else
          setMessages((messages) =>
            messages.map((message) =>
              message.id === assistantId ? { ...message, toolCalls: currentToolCalls() } : message
            )
          );
        // Saved at once, so a renderer that dies before the turn ends (or a
        // card that commits after Stop) can't lose a send.
        if (patch.actionKey) checkpoint();
      };

      const recordExecutedResult = (id: string, result: ToolResult): void => {
        if (cancelled()) {
          const call = toolCalls.find((call) => call.id === id);
          if (call && !SKILL_CARD_TOOLS.has(call.name)) return;
        }
        const metadata =
          result.success && result.data && typeof result.data === "object"
            ? (result.data as ToolCallInfo["metadata"])
            : undefined;
        const patch: Partial<ToolCallInfo> = {
          status: "completed",
          result: result.displayText,
          ...(metadata && !isQueryResultData(metadata) ? { metadata } : {}),
          ...(result.success ? {} : { failed: true }),
        };
        turnHooks.annotate?.(id, patch);
        const call = toolCalls.find((call) => call.id === id);
        // Stop can discard a partial answer, but cannot undo a skill already saved.
        if (call && readSkillCardRecord(call)?.status === "saved") {
          save(
            options?.persistAssistantMessage ?? onTurnCheckpoint ?? onStreamComplete,
            allowInteractions ||
              (turn.finishedAt != null && turn.status !== "error" && !control.explicit)
              ? fullContent
              : ""
          );
        }
      };

      // A stop keeps what the reply has so far, and every call still running
      // ends with it. Questions it was waiting on are dismissed by Esc or
      // Stop; an unmount leaves them to answer later. A tool still waiting
      // for its service to connect never ran.
      const settleStoppedTurn = (explicit: boolean): void => {
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

      // An unmount mid-stream (page navigation) keeps the partial reply in
      // history so the saved conversation matches what the user last saw.
      // The agent chat also keeps a reply stopped by Esc, Stop or a switch
      // to another chat, with what its tools did and the questions it was
      // waiting on; elsewhere an explicit cancel drops it. Neither path may
      // run the per-request delivery hook.
      const finishStopped = (): void => {
        settleStoppedTurn(control.explicit);
        flushContentNow();
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId ? { ...message, isStreaming: false } : message
          )
        );
        // A reply saved when its turn started is completed as stopped, even empty.
        const keepsReply = allowInteractions
          ? fullContent.trim().length > 0 || toolCalls.length > 0 || Boolean(checkpointHandler)
          : !control.explicit && fullContent.trim().length > 0;
        if (keepsReply) saveReply();
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
      // Where the text of the step now streaming starts, so an answer asked
      // again (an unbacked claim) can be withdrawn.
      let stepTextStart = 0;
      let unbackedClaim = false;
      // Where a reply the claim check asked about starts. It stays on screen
      // until the second answer replaces it: a stop or failure must not lose it.
      let askedAgainFrom: number | null = null;
      // How much of the reply a voice call has heard: it grows with the
      // visible text, and shrinks only when a claim's answer is withdrawn.
      let heardLength = 0;
      const tellSpeech = (): void => {
        if (!speech || fullContent.length <= heardLength) return;
        speech.onText(fullContent.slice(heardLength), isUnbacked);
        heardLength = fullContent.length;
      };
      const replaceAskedReply = (): void => {
        if (askedAgainFrom === null) return;
        rawContent = rawContent.slice(0, askedAgainFrom);
        fullContent = withoutEchoedToolTrace(rawContent);
        afterToolCall = true;
        askedAgainFrom = null;
        if (speech && heardLength > fullContent.length) {
          heardLength = fullContent.length;
          speech.onTextWithdrawn(heardLength);
        }
      };
      const keepAskedReply = (): void => {
        if (askedAgainFrom === null) return;
        askedAgainFrom = null;
        unbackedClaim = true;
        turn = { ...turn, unbackedClaim: true };
      };
      // A final answer that says it did something needs a tool result of
      // that kind: this turn's (not one a regenerate carried over), or for a
      // report on what was done, one recorded for an earlier turn.
      const isUnbacked = registry
        ? (text: string) =>
            isUnbackedClaim(text, {
              turnCalls: toolCalls.slice(carriedCallCount),
              earlierCalls: [
                ...allMessages.flatMap((message) => message.toolCalls ?? []),
                ...toolCalls.slice(0, carriedCallCount),
              ],
              isOffered: (name) => registry.get(name) !== undefined,
              request: {
                text: userText,
                selectedText: selectedContext?.text ?? lastUserMessage?.selectedContext,
              },
            })
        : undefined;

      try {
        // Saved before it streams, so the conversation shows a turn in progress.
        if (!replaced) await checkpoint();
        if (cancelled()) {
          if (restoresReplaced()) restoreReplaced();
          else finishStopped();
          return;
        }
        let stream: AsyncGenerator<AgentStreamChunk>;
        // Each call's own step text on the AI SDK path, whose tool results
        // carry only the model-facing output (the cloud path yields it).
        const toolDisplayTexts = new Map<string, string>();

        if (isCloudAgent) {
          const executeToolCall = registry
            ? async (name: string, argsJson: string, toolCallId: string) => {
                const tool =
                  registry.get(name) ?? (name === lookAtScreen?.name ? lookAtScreen : undefined);
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
                  toolScope.createContext({
                    messageId: assistantId,
                    toolCallId: currentToolCallId(toolCallId),
                  }),
                  (result) => recordExecutedResult(currentToolCallId(toolCallId), result)
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

          stream = ReasoningService.processTextStreamingCloud(
            llmMessages,
            {
              systemPrompt,
              tools: offeredTools?.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
              executeToolCall,
              ...(cloudScreenContext ? { screenContext: cloudScreenContext } : {}),
              isUnbackedClaim: isUnbacked,
            },
            control.controller.signal
          );
        } else {
          const aiTools = registry?.toAISDKFormat(
            (toolCallId, abortSignal) =>
              toolScope.createContext({
                messageId: assistantId,
                toolCallId: currentToolCallId(toolCallId),
                signal: abortSignal,
              }),
            (id, text, result) => {
              toolDisplayTexts.set(currentToolCallId(id), text);
              recordExecutedResult(currentToolCallId(id), result);
            }
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
              isUnbackedClaim: isUnbacked,
            },
            aiTools,
            control.controller.signal
          );
        }

        for await (const chunk of stream) {
          // Nothing a cancelled turn streams afterwards is shown or kept.
          if (cancelled()) {
            control.controller.abort();
            break;
          }
          if (chunk.type === "content") {
            replaceAskedReply();
            if (afterToolCall && rawContent && !/\s$/.test(rawContent)) rawContent += "\n\n";
            afterToolCall = false;
            rawContent += chunk.text;
            fullContent = withoutEchoedToolTrace(rawContent);
            tellSpeech();
            scheduleContentFlush();
          } else if (chunk.type === "reasoning") {
            if (reasoningAfterToolCall && reasoning && !/\s$/.test(reasoning)) reasoning += "\n\n";
            reasoningAfterToolCall = false;
            reasoning += chunk.text;
            scheduleContentFlush();
          } else if (chunk.type === "unbacked_claim") {
            if (chunk.retry) {
              askedAgainFrom = stepTextStart;
              flushContentNow();
            } else {
              unbackedClaim = true;
            }
          } else if (chunk.type === "tool_calls") {
            replaceAskedReply();
            afterToolCall = true;
            reasoningAfterToolCall = true;
            stepTextStart = rawContent.length;
            speech?.onToolCalls(chunk.calls.map((call) => call.name));
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
                  id: currentToolCallId(call.id),
                  name: call.name,
                  // A question to look_at_screen can quote an earlier read.
                  arguments: call.name === lookAtScreen?.name ? "{}" : call.arguments,
                  status: "executing",
                  startedAt: Date.now(),
                  textOffset: fullContent.length,
                  ...annotations.get(currentToolCallId(call.id)),
                },
              ];
            }
            if (
              chunk.calls.some((call) => annotations.get(currentToolCallId(call.id))?.interaction)
            ) {
              updateWaiting();
            } else {
              flushContentNow();
            }
          } else if (chunk.type === "tool_result") {
            const toolCallId = currentToolCallId(chunk.callId);
            toolCalls = toolCalls.map((tc) =>
              tc.id === toolCallId
                ? {
                    ...tc,
                    status: chunk.isError ? ("error" as const) : ("completed" as const),
                    finishedAt: Date.now(),
                    ...(chunk.isError ? { failed: true } : {}),
                    result: toolDisplayTexts.get(toolCallId) ?? chunk.displayText,
                    ...(chunk.metadata && !isQueryResultData(chunk.metadata)
                      ? {
                          metadata: productHelpMetadata(tc.name, chunk.metadata) ?? chunk.metadata,
                        }
                      : {}),
                  }
                : tc
            );
            flushContentNow();
            setAgentState("streaming");
            completeToolActivity();
          } else if (chunk.type === "done") {
            // Ended from outside the turn: it stops, rather than counting as answered.
            if (chunk.finishReason === "abort") {
              control.controller.abort();
              break;
            }
            stepLimitReached = chunk.finishReason === "tool-calls";
          }
        }

        if (cancelled()) {
          keepAskedReply();
          if (restoresReplaced()) restoreReplaced();
          else finishStopped();
          return;
        }

        // Asked again and nothing came back: the first answer stands, noted.
        keepAskedReply();

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
        tellSpeech();
        speechOutcome = "complete";

        turn = {
          ...turn,
          finishedAt: Date.now(),
          status: stepLimitReached ? "step_limit" : "complete",
          ...(unbackedClaim ? { unbackedClaim: true } : {}),
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
          keepAskedReply();
          finishStopped();
        } else if (askedAgainFrom !== null) {
          // The second ask failed: the first answer stands, noted.
          keepAskedReply();
          speechOutcome = "complete";
          turn = { ...turn, finishedAt: Date.now(), status: "complete" };
          flushContentNow();
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, isStreaming: false } : m))
          );
          saveReply();
        } else {
          cancelContentFlush();
          const errorContext = {
            provider: getProviderDisplayName(llmConfig.provider),
            model: llmConfig.model,
            surface: "llm",
            selfHosted: isLanAgent || isCustomAgent,
          };
          const classified = asProviderError(error, errorContext);
          const failure = describeProviderError(
            classified?.messageKey
              ? classified
              : providerError(PROVIDER_ERROR_CODES.ERROR, {
                  ...errorContext,
                  technicalDetails: {
                    underlyingError: redactProviderBody(
                      error instanceof Error ? error.message : error
                    ),
                  },
                }),
            t
          );
          // Set on every failed reply: the chat then knows the failure is on screen.
          const messageError: MessageError = {
            ...(failure.technicalDetails ? { technicalDetails: failure.technicalDetails } : {}),
            ...(failure.settingsTarget ? { settingsTarget: failure.settingsTarget } : {}),
          };
          settleStoppedTurn(true);
          turn = { ...turn, status: "error" };
          if (speech) {
            speech.onTextWithdrawn(0);
            speech.onText(failure.description);
            speechOutcome = "error";
          }
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
          // The agent chat saves a failed reply as failed, so a reload says so
          // and remembers what its tools did; other chats only show it.
          if (allowInteractions) saveReply();
        }
      }

      setAgentState("idle");
      completeToolActivity();
    }
  };
  return { send, cancel };
}
