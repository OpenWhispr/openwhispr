import type { AgentWindowLayout } from "../../types/electron";
import type { AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { InteractionPayload } from "../../types/agentInteractions";
import { approvalKey, type ApprovalEntry } from "../../stores/connectorApprovalStore";
import type { SkillApprovalEntry } from "../../stores/skillApprovalStore";
import type { InteractionEntry } from "../../stores/agentInteractionStore";
import type { ChatImageAttachment, Message, ToolCallInfo } from "../chat/types";

export type AgentInputMode = "voice" | "keyboard";

/**
 * The agent window's shell: which layout shows, how the user is giving input,
 * and what rides with the next request. The draft and the selected context
 * survive every layout and input change; only a send or a close clears what
 * belongs to one request.
 */
export interface AgentWindowState {
  visible: boolean;
  layout: AgentWindowLayout;
  input: AgentInputMode;
  /** The typed request in progress. A spoken request never consumes it. */
  draft: string;
  selectedContext: AgentSelectionContext | null;
  /** A screenshot taken when the hotkey was pressed. */
  attachment: ChatImageAttachment | null;
  /** An i18n key the pill shows in place of its waveform. */
  notice: string | null;
}

export type AgentWindowAction =
  | { type: "show"; layout: AgentWindowLayout; input: AgentInputMode }
  | { type: "expand" }
  /** pending: a card is waiting on the user, so the pill waits for its answer. */
  | { type: "collapse"; pending?: boolean }
  /** pending: the card opens in the modal, with the composer. */
  | { type: "useKeyboard"; pending?: boolean }
  /**
   * A card arrived while compact: one that asks something shows above the
   * pill. From the typing layout (or a card above the pill with keyboard
   * input), where the keyboard has to stay with the window and with a draft,
   * an answer card, or a card that asks while a draft is written, opens in
   * the modal instead; otherwise an answer card waits behind the pill.
   */
  | { type: "showCard"; asks: boolean }
  /** The standalone card is answered or gone. */
  | { type: "cardSettled" }
  | { type: "useVoice" }
  | { type: "setDraft"; draft: string }
  | { type: "appendDraft"; text: string }
  | { type: "setContext"; context: AgentSelectionContext | null }
  | { type: "setAttachment"; attachment: ChatImageAttachment | null }
  | {
      type: "submitted";
      typed: boolean;
      draft: string;
      selectedContext: AgentSelectionContext | null;
      attachment: ChatImageAttachment | null;
    }
  | {
      type: "held";
      text: string;
      context: AgentSelectionContext | null;
      attachment: ChatImageAttachment | null;
    }
  | { type: "notice"; notice: string | null }
  | { type: "hide" };

export const INITIAL_AGENT_WINDOW_STATE: AgentWindowState = {
  visible: false,
  layout: "pill",
  input: "voice",
  draft: "",
  selectedContext: null,
  attachment: null,
  notice: null,
};

// Collapsing the modal goes back to the compact layout of the current input.
const compactLayout = (input: AgentInputMode): AgentWindowLayout =>
  input === "keyboard" ? "typing" : "pill";

export function agentWindowReducer(
  state: AgentWindowState,
  action: AgentWindowAction
): AgentWindowState {
  switch (action.type) {
    case "show":
      return {
        ...state,
        visible: true,
        layout: state.visible && state.layout === "modal" ? "modal" : action.layout,
        input: action.input,
        notice: null,
      };
    case "expand":
      return { ...state, layout: "modal" };
    case "collapse":
      return { ...state, layout: action.pending ? "pill" : compactLayout(state.input) };
    case "useKeyboard":
      return {
        ...state,
        input: "keyboard",
        layout: action.pending ? "modal" : state.layout === "pill" ? "typing" : state.layout,
        notice: null,
      };
    case "showCard": {
      if (state.layout === "modal") return state;
      // The keyboard stays with the window (and with a draft) from the typing
      // layout, or from a card above the pill the user is typing on.
      const typing =
        state.layout === "typing" || (state.layout === "standalone" && state.input === "keyboard");
      if (typing && (!action.asks || state.draft.trim() !== "")) {
        return { ...state, layout: "modal" };
      }
      return { ...state, layout: action.asks ? "standalone" : "pill" };
    }
    case "cardSettled":
      return state.layout === "standalone"
        ? { ...state, layout: compactLayout(state.input) }
        : state;
    case "useVoice":
      return {
        ...state,
        input: "voice",
        layout: state.layout === "typing" ? "pill" : state.layout,
        notice: null,
      };
    case "setDraft":
      return { ...state, draft: action.draft };
    case "appendDraft": {
      const draft = state.draft.trim();
      return { ...state, draft: draft ? `${draft} ${action.text}` : action.text };
    }
    case "setContext":
      return { ...state, selectedContext: action.context };
    case "setAttachment":
      return { ...state, attachment: action.attachment };
    case "submitted":
      // A typed request is answered in the modal at once; a spoken one thinks
      // in the pill until the answer has something to show.
      return {
        ...state,
        layout: action.typed ? "modal" : state.layout,
        draft: action.typed && state.draft === action.draft ? "" : state.draft,
        selectedContext:
          state.selectedContext === action.selectedContext ? null : state.selectedContext,
        attachment: state.attachment === action.attachment ? null : state.attachment,
        notice: null,
      };
    case "held": {
      // A request that arrived while a reply runs waits in the composer, with
      // what it brought, for the user to send.
      const draft = state.draft.trim();
      return {
        ...state,
        input: "keyboard",
        layout: state.layout === "pill" ? "typing" : state.layout,
        draft: draft ? `${draft} ${action.text}` : action.text,
        selectedContext: action.context ?? state.selectedContext,
        attachment: action.attachment ?? state.attachment,
        notice: null,
      };
    }
    case "notice":
      return { ...state, notice: action.notice };
    case "hide":
      return {
        ...state,
        visible: false,
        layout: "pill",
        input: "voice",
        selectedContext: null,
        attachment: null,
        notice: null,
      };
  }
}

/**
 * A card waiting on typed input (an ask_user text answer, an API key). Windows
 * and Linux give the window the keyboard only when it asks, so it has to ask
 * for these even after a spoken request.
 */
export function awaitsTypedAnswer(messages: ReadonlyArray<Pick<Message, "toolCalls">>): boolean {
  return messages.some((message) =>
    message.toolCalls?.some(({ interaction }) => {
      if (interaction?.state !== "pending") return false;
      const { payload } = interaction;
      return (
        payload.kind === "apiKey" ||
        (payload.kind === "questions" &&
          payload.questions.some((question) => question.kind === "text"))
      );
    })
  );
}

export interface PendingCard {
  /** The stores' key for the tool call. */
  key: string;
  /**
   * This card: an interaction and the answer card that follows it on the
   * same tool call are different cards.
   */
  id: string;
  messageId: string;
  toolCall: ToolCallInfo;
  /** The interaction's kind; null for an answer card. */
  interaction: InteractionPayload["kind"] | null;
}

/**
 * The first card a running turn waits on the user for: an interaction (a
 * question, a connect, …) still open, or an answer card waiting on Send or on
 * a Retry. Only cards of the messages on screen count. A card restored from a
 * turn that ended counts only with `includeRestored`: no turn waits on it, but
 * the composer can still answer it.
 */
export function findPendingCard(
  messages: ReadonlyArray<Pick<Message, "id" | "toolCalls">>,
  interactions: Readonly<Record<string, Pick<InteractionEntry, "state" | "payload" | "restored">>>,
  approvals: Readonly<Record<string, Pick<ApprovalEntry, "state" | "awaitingRetry">>>,
  {
    includeRestored = false,
    skillApprovals = {},
  }: {
    includeRestored?: boolean;
    skillApprovals?: Readonly<Record<string, Pick<SkillApprovalEntry, "state">>>;
  } = {}
): PendingCard | null {
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      const key = approvalKey(message.id, toolCall.id);
      const interaction = interactions[key];
      if (
        interaction &&
        interaction.state !== "settled" &&
        (includeRestored || !interaction.restored)
      ) {
        const { kind } = interaction.payload;
        return { key, id: `${key}:${kind}`, messageId: message.id, toolCall, interaction: kind };
      }
      const skillApproval = skillApprovals[key];
      if (skillApproval?.state === "pending") {
        return { key, id: `${key}:skill`, messageId: message.id, toolCall, interaction: null };
      }
      const approval = approvals[key];
      if (approval?.state === "pending" || approval?.awaitingRetry) {
        return { key, id: `${key}:approval`, messageId: message.id, toolCall, interaction: null };
      }
    }
  }
  return null;
}

/**
 * What the chat shows: a fork shows its own turns, under the chip that opens
 * the chat it came from. The copied history stays in the fork and goes with
 * every request; it shows only when that chat is gone, and the chip with it.
 * Until the fork has a turn of its own, a copied last reply whose question
 * (or other card) was left unanswered shows too: the fork can still answer it,
 * so it never waits unseen.
 */
export function shownMessages<T extends Pick<Message, "toolCalls">>(
  messages: T[],
  forkOrigin: { parentTitle: string | null; copiedMessageCount: number } | null
): T[] {
  if (!forkOrigin?.parentTitle) return messages;
  const copied = forkOrigin.copiedMessageCount;
  const waits =
    copied === messages.length &&
    messages[copied - 1]?.toolCalls?.some((call) => call.interaction?.state === "interrupted");
  return messages.slice(waits ? copied - 1 : copied);
}

export type AgentPillPlacement = "compact" | "typing" | "modal";
export type AgentPillStatus =
  "idle" | "listening" | "transcribing" | "waiting" | "thinking" | "streaming";
export type AgentPillButton = "expand" | "mic" | "keyboard" | "stop" | "close";

export interface AgentPillControls {
  waveform: boolean;
  /** "Thinking…" in place of the waveform. */
  thinking: boolean;
  /** "Waiting for answer" in place of the waveform. */
  waiting: boolean;
  buttons: AgentPillButton[];
}

/**
 * The pill's controls for where it shows and what is happening. Expand only
 * exists outside the modal; the typing layout swaps Keyboard for Mic. A notice
 * (it heard nothing, say) leaves the compact pill room for Mic and Close only.
 * "Thinking…" covers transcribing and a reply with nothing to show yet; in the
 * modal that reply can already be stopped. Waiting for an answer, the pill
 * offers the keyboard (and Expand) to reach the card.
 */
export function resolveAgentPillControls(
  placement: AgentPillPlacement,
  status: AgentPillStatus,
  notice = false
): AgentPillControls {
  const controls = (buttons: AgentPillButton[], shows: Partial<AgentPillControls> = {}) => ({
    waveform: false,
    thinking: false,
    waiting: false,
    ...shows,
    buttons,
  });
  if (placement === "typing") return controls(["expand", "mic", "close"]);
  if (notice && placement === "compact" && status === "idle") return controls(["mic", "close"]);
  const expand: AgentPillButton[] = placement === "compact" ? ["expand"] : [];
  switch (status) {
    case "listening":
      return controls([...expand, "keyboard", "close"], { waveform: true });
    case "transcribing":
      return controls(["keyboard", "close"], { thinking: true });
    case "waiting":
      return controls(["keyboard", ...expand, "close"], { waiting: true });
    case "thinking":
      return controls(
        placement === "modal" ? ["keyboard", "stop", "close"] : ["keyboard", "close"],
        { thinking: true }
      );
    case "streaming":
      return controls([...expand, "keyboard", "stop", "close"]);
    case "idle":
      return controls([...expand, "mic", "keyboard", "close"]);
  }
}
