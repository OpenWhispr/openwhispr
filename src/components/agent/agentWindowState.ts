import type { AgentWindowLayout } from "../../types/electron";
import type { AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { ChatImageAttachment, Message } from "../chat/types";

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
  | { type: "collapse" }
  | { type: "useKeyboard" }
  | { type: "useVoice" }
  | { type: "setDraft"; draft: string }
  | { type: "appendDraft"; text: string }
  | { type: "setContext"; context: AgentSelectionContext | null }
  | { type: "setAttachment"; attachment: ChatImageAttachment | null }
  | { type: "submitted"; typed: boolean }
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
      return { ...state, layout: compactLayout(state.input) };
    case "useKeyboard":
      return {
        ...state,
        input: "keyboard",
        layout: state.layout === "pill" ? "typing" : state.layout,
        notice: null,
      };
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
        draft: action.typed ? "" : state.draft,
        selectedContext: null,
        attachment: null,
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

export type AgentPillPlacement = "compact" | "typing" | "modal";
export type AgentPillStatus = "idle" | "listening" | "transcribing" | "thinking" | "streaming";
export type AgentPillButton = "expand" | "mic" | "keyboard" | "stop" | "close";

export interface AgentPillControls {
  waveform: boolean;
  /** "Thinking…" in place of the waveform. */
  thinking: boolean;
  buttons: AgentPillButton[];
}

/**
 * The pill's controls for where it shows and what is happening. Expand only
 * exists outside the modal; the typing layout swaps Keyboard for Mic. A notice
 * (it heard nothing, say) leaves the compact pill room for Mic and Close only.
 * "Thinking…" covers transcribing and a reply with nothing to show yet; in the
 * modal that reply can already be stopped.
 */
export function resolveAgentPillControls(
  placement: AgentPillPlacement,
  status: AgentPillStatus,
  notice = false
): AgentPillControls {
  if (placement === "typing") {
    return { waveform: false, thinking: false, buttons: ["expand", "mic", "close"] };
  }
  if (notice && placement === "compact" && status === "idle") {
    return { waveform: false, thinking: false, buttons: ["mic", "close"] };
  }
  const expand: AgentPillButton[] = placement === "compact" ? ["expand"] : [];
  switch (status) {
    case "listening":
      return { waveform: true, thinking: false, buttons: [...expand, "keyboard", "close"] };
    case "transcribing":
      return { waveform: false, thinking: true, buttons: ["keyboard", "close"] };
    case "thinking":
      return {
        waveform: false,
        thinking: true,
        buttons: placement === "modal" ? ["keyboard", "stop", "close"] : ["keyboard", "close"],
      };
    case "streaming":
      return {
        waveform: false,
        thinking: false,
        buttons: [...expand, "keyboard", "stop", "close"],
      };
    case "idle":
      return { waveform: false, thinking: false, buttons: [...expand, "mic", "keyboard", "close"] };
  }
}
