import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import AssistantNoteUndoListener from "../notes/AssistantNoteUndoListener";
import { mirrorActiveAccountScope } from "../../lib/accountScopeMirror";
import { subscribeAuthBoundary } from "../../lib/authRequestContext";
import { usePolicyStore } from "../../stores/policyStore";
import { isAgentAllowed, isScreenContextAllowed } from "../../stores/policyRules";
import { getSettings } from "../../stores/settingsStore";
import { resolveAgentAccessRefusal } from "../../helpers/agentAccessPolicy";
import {
  CARDS_WITHOUT_DISMISS,
  answerWithText,
  useAgentInteractionStore,
} from "../../stores/agentInteractionStore";
import {
  approvalKey,
  updateApprovalDraft,
  useConnectorApprovalStore,
} from "../../stores/connectorApprovalStore";
import { editSelectedText } from "../../services/editSelectedText";
import type { ToneAppCategory } from "../../config/toneStyle";
import { useSkillApprovalStore } from "../../stores/skillApprovalStore";
import { INTERACTION_TOOL_NAMES } from "../../services/tools/interactionTools";
import type { ChatImageAttachment, Message } from "../chat/types";
import { unsentForkContext, type AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { AgentWindowCommand, AgentWindowLayout } from "../../types/electron";
import {
  agentWindowReducer,
  awaitsTypedAnswer,
  findPendingCard,
  INITIAL_AGENT_WINDOW_STATE,
  resolveAgentPillControls,
  shownMessages,
  type AgentPillButton,
  type AgentPillPlacement,
  type AgentPillStatus,
  type AgentWindowAction,
  type AgentWindowState,
} from "./agentWindowState";
import { useAgentSurface } from "./useAgentSurface";
import { useAgentVoice, type AgentVoiceIntent } from "./useAgentVoice";
import { useAgentChat } from "./useAgentChat";
import { useReadAloud } from "./useReadAloud";
import { useAnswerNudge } from "./useAnswerNudge";
import { AgentPill } from "./AgentPill";
import { AgentComposer } from "./AgentComposer";
import { AgentModal, type AgentModalGlow } from "./AgentModal";
import { AgentMessageList } from "./AgentMessages";
import { ToolCallCard } from "../chat/ChatMessage";
import { SkillChip } from "../chat/SkillChip";
import { SelectedContextBlock } from "./AgentContext";

// How long a spoken request waits for the press-time selection and screenshot.
const PRESS_CAPTURE_WAIT_MS = 3000;
// How long a new step may take to show the card it asks with.
const STEP_SETTLE_MS = 300;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RequestExtras {
  selectedContext?: AgentSelectionContext | null;
  attachment?: ChatImageAttachment | null;
}

type SelectionEditTarget =
  | { kind: "external"; sessionId: string; text: string; appCategory: ToneAppCategory | null }
  | {
      kind: "approval";
      key: string;
      actionId: string;
      field: "body" | "subject";
      draftValue: string;
      value: string;
      start: number;
      end: number;
      text: string;
      appCategory: ToneAppCategory;
    };

function selectedApprovalField(): SelectionEditTarget | null {
  const field = document.activeElement;
  if (!(field instanceof window.HTMLTextAreaElement || field instanceof window.HTMLInputElement))
    return null;
  const name = field.getAttribute("data-approval-field");
  if (name !== "body" && name !== "subject") return null;
  const key = field.closest("[data-approval-card]")?.getAttribute("data-approval-card");
  if (!key) return null;
  const entry = useConnectorApprovalStore.getState().entries[key];
  if (!entry || entry.reconnect || (entry.state !== "pending" && !entry.awaitingRetry)) return null;
  if (entry.preview.verbKey !== "email" && entry.preview.verbKey !== "slackPost") return null;
  const start = field.selectionStart ?? 0;
  const end = field.selectionEnd ?? start;
  if (start === end) return null;
  const draftValue = entry.draft.fields?.[name] ?? (name === "body" ? entry.draft.body : undefined);
  if (typeof draftValue !== "string") return null;
  return {
    kind: "approval",
    key,
    actionId: entry.actionId,
    field: name,
    draftValue,
    value: field.value,
    start,
    end,
    text: field.value.slice(start, end),
    appCategory: entry.preview.verbKey === "email" ? "email" : "work",
  };
}

async function captureRequestScreen(): Promise<ChatImageAttachment | null> {
  if (!getSettings().voiceAgentScreenContext || !isScreenContextAllowed(usePolicyStore.getState()))
    return null;
  try {
    const image = await Promise.race([
      window.electronAPI?.captureScreenContext?.(),
      delay(PRESS_CAPTURE_WAIT_MS).then(() => null),
    ]);
    return image ? { image: image.data, mediaType: image.mediaType } : null;
  } catch {
    return null;
  }
}

/**
 * The agent window's root (`?agent=true`): the pill, the composer above it and
 * the modal, over one running chat. Recording, the turn, the draft and the
 * selected context all live here, so they survive every layout change.
 */
export default function AgentWindow() {
  const { t, i18n } = useTranslation();
  // Kept in a ref as well, so a request built after an await sees the latest.
  const [state, setState] = useState<AgentWindowState>(INITIAL_AGENT_WINDOW_STATE);
  const stateRef = useRef(state);
  const dispatch = useCallback((action: AgentWindowAction) => {
    stateRef.current = agentWindowReducer(stateRef.current, action);
    setState(stateRef.current);
  }, []);
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const policyStatus = usePolicyStore((policy) => policy.status);
  const policyResolved =
    policyStatus === "idle" || policyStatus === "managed" || policyStatus === "unmanaged";
  // An i18n key explaining why the assistant can't run, shown in the modal.
  const [refusal, setRefusal] = useState<string | null>(null);

  // The sandboxed window can't resolve a session; policy follows main's account.
  useEffect(() => mirrorActiveAccountScope(), []);

  const onRegenerateFailed = useCallback(
    () => dispatch({ type: "notice", notice: "agentWindow.notices.regenerateFailed" }),
    [dispatch]
  );
  const chat = useAgentChat({ onRegenerateFailed });
  const {
    busy: chatBusy,
    cancel: cancelTurn,
    conversationId,
    fork,
    forkOrigin,
    messages,
    newChat: startNewChat,
    regenerate: regenerateReply,
    switchChat: openChat,
  } = chat;
  const [editingSelection, setEditingSelection] = useState(false);
  const busy = chatBusy || editingSelection;
  const chatBusyRef = useRef(chatBusy);
  chatBusyRef.current = chatBusy;
  const editTargetRef = useRef<SelectionEditTarget | null>(null);
  const selectionEditRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pressRef.current += 1;
      selectionEditRef.current?.abort();
      selectionEditRef.current = null;
    },
    []
  );
  // A new function every render; read through a ref so callbacks stay stable.
  const sendRef = useRef(chat.send);
  sendRef.current = chat.send;
  const readAloud = useReadAloud(i18n.language);
  const { stop: stopReading } = readAloud;

  // A fork's list leaves out the history it copied (the chip opens it).
  const shown = useMemo(() => shownMessages(messages, forkOrigin), [forkOrigin, messages]);
  // The card the turn waits on: above the pill when it arrives while compact.
  const interactions = useAgentInteractionStore((store) => store.entries);
  const approvals = useConnectorApprovalStore((store) => store.entries);
  const skillApprovals = useSkillApprovalStore((store) => store.entries);
  const pendingCard = useMemo(
    () => findPendingCard(shown, interactions, approvals, { skillApprovals }),
    [approvals, interactions, shown, skillApprovals]
  );
  // What the composer answers: a restored question too, though nothing waits on it.
  const answerableCard = useMemo(
    () =>
      findPendingCard(shown, interactions, approvals, { includeRestored: true, skillApprovals }),
    [approvals, interactions, shown, skillApprovals]
  );
  // A card waiting on the user or sending carries the turn: the pill reads as
  // at rest. Stop stays only beside a card with no dismiss control of its own
  // (a question, key or settings card); any other card ends the wait itself.
  const cardSending = useMemo(
    () =>
      shown.some((message) =>
        message.toolCalls?.some(
          (call) => approvals[approvalKey(message.id, call.id)]?.state === "committing"
        )
      ),
    [approvals, shown]
  );
  const cardHolds = pendingCard !== null || cardSending;
  const offersStop =
    !cardSending &&
    (pendingCard === null ||
      (pendingCard.interaction !== null && CARDS_WITHOUT_DISMISS.has(pendingCard.interaction)));
  // Read when a spoken command arrives, so it can be kept from answering.
  const pendingCardRef = useRef(pendingCard);
  pendingCardRef.current = pendingCard;
  const cardFrameRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const standalone = state.layout === "standalone";
  // Measured before paint, so the window is sized for the card it opens to.
  useLayoutEffect(() => {
    const frame = cardFrameRef.current;
    if (!standalone || !frame) return;
    const measure = () => setCardHeight(Math.ceil(frame.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [standalone]);

  // A click in the modal or on a standalone card after a spoken request may be
  // into a card's field.
  const cardShown = state.visible && (state.layout === "modal" || standalone);
  const [cardClicked, setCardClicked] = useState(false);
  useEffect(() => {
    if (!cardShown) setCardClicked(false);
  }, [cardShown]);
  // A move the window makes by itself (the timed open, a card from the
  // keyboard layouts) keeps the keyboard only if the window has it, so it
  // never takes it from the app the user went to. The user pointing at the
  // window, the window getting focus, a press of the hotkey or a new spoken
  // command ends that.
  const [movedAway, setMovedAway] = useState(false);
  const moveOnItsOwn = useCallback(
    (action: AgentWindowAction) => {
      setMovedAway(!document.hasFocus());
      dispatch(action);
    },
    [dispatch]
  );
  useEffect(() => {
    const onFocus = () => setMovedAway(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  // Who has the keyboard is decided here: the window (asked of main, never
  // after a move made while the user was away), and in it the composer, unless
  // a key card is shown and no message is being written (the key field takes
  // it then). The composer's own focus doesn't follow movedAway, so a user who
  // comes back and clicks a card's field keeps it. A card places the caret
  // inside itself (InteractionCard's useCardFocus).
  const keyboardWanted =
    state.layout !== "pill" &&
    (state.input === "keyboard" ||
      ((state.layout === "modal" || standalone) && (cardClicked || awaitsTypedAnswer(messages))));
  const surfaceFocus = keyboardWanted && !movedAway;

  // A card that arrives while compact shows above the pill if it asks
  // something; an answer card waits behind the pill instead (or, from the
  // typing layout, opens in the modal). Once it is answered the window goes
  // back to how it was. A card the user minimized stays behind the pill.
  const shownCardsRef = useRef(new Set<string>());
  const [draftHeldCard, setDraftHeldCard] = useState<string | null>(null);
  useEffect(() => {
    if (!state.draft.trim()) setDraftHeldCard(null);
  }, [state.draft]);
  useEffect(() => {
    if (!pendingCard) {
      if (standalone) dispatch({ type: "cardSettled" });
      return;
    }
    const asks = pendingCard.interaction !== null;
    const fresh = !shownCardsRef.current.has(pendingCard.id);
    shownCardsRef.current.add(pendingCard.id);
    if (!fresh && !(standalone && !asks)) return;
    // A question that arrives while a message is being written isn't answered
    // from the composer until it is emptied: Enter would send the message as the answer.
    if (fresh && pendingCard.interaction === "questions" && stateRef.current.draft.trim()) {
      setDraftHeldCard(pendingCard.key);
    }
    // In the modal the card shows where it is: the window doesn't move.
    const moves = stateRef.current.input === "keyboard" && stateRef.current.layout !== "modal";
    if (moves) moveOnItsOwn({ type: "showCard", asks });
    else dispatch({ type: "showCard", asks });
  }, [dispatch, moveOnItsOwn, pendingCard, standalone]);

  // A reply opens the modal once it has something to show: text, an error, or
  // a step that is doing more than asking the user (D2). A spoken request that
  // asks first keeps its card above the pill, a connector's step that asks to
  // connect included; such a step reports its card just after it starts, so a
  // step gets a moment before it counts. Once per reply: the user opening the
  // modal counts too, so a reply never reopens a modal the user minimized.
  const latest = messages.at(-1);
  const replyId = latest?.role === "assistant" ? latest.id : null;
  const replyShows = replyId !== null && Boolean(latest?.content || latest?.error);
  const replyWorks =
    replyId !== null &&
    Boolean(
      latest?.toolCalls?.some(
        (call) => !INTERACTION_TOOL_NAMES.has(call.name) && call.interaction?.state !== "pending"
      )
    );
  const expandedRepliesRef = useRef(new Set<string>());
  useEffect(() => {
    if (replyId === null || expandedRepliesRef.current.has(replyId)) return;
    if (!replyShows && !replyWorks) return;
    const expand = () => {
      expandedRepliesRef.current.add(replyId);
      if (stateRef.current.layout !== "modal") dispatch({ type: "expand" });
    };
    if (replyShows) {
      expand();
      return;
    }
    const timer = setTimeout(expand, STEP_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [dispatch, replyId, replyShows, replyWorks]);
  useEffect(() => {
    if (state.layout === "modal" && replyId !== null) expandedRepliesRef.current.add(replyId);
  }, [replyId, state.layout]);

  // The press that opened the window owns it until the user does something
  // else: Esc on its take then closes the window again.
  const openedByTakeRef = useRef(false);
  // Pending captures from the press (another app's selection, a screenshot).
  const pressCaptureRef = useRef<Promise<unknown> | null>(null);
  const pressRef = useRef(0);
  // Takes are numbered as they start; every take up to droppedTakeRef was
  // dropped (closed, dismissed, another chat opened) and is never sent, even
  // when a new take starts while its transcript waits on the press capture.
  const takeRef = useRef(0);
  const droppedTakeRef = useRef(0);

  // Read when a request arrives; set at once on a send, before the next render.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const refuseIfRestricted = useCallback(() => {
    const reason = resolveAgentAccessRefusal({ agentAllowed, policyResolved });
    if (!reason) return false;
    setRefusal(reason);
    dispatch({ type: "show", layout: "modal", input: "keyboard" });
    return true;
  }, [agentAllowed, dispatch, policyResolved]);

  const submit = useCallback(
    (text: string, typed: boolean, extras?: RequestExtras) => {
      if (refuseIfRestricted()) return;
      pressRef.current += 1;
      pressCaptureRef.current = null;
      const current = stateRef.current;
      const selectedContext = extras ? extras.selectedContext : current.selectedContext;
      const attachment = extras ? extras.attachment : current.attachment;
      // A wake-word command can arrive while a reply runs; it waits rather
      // than being lost or cutting the reply off. A question waiting
      // meanwhile is answered on its card, never with the command, as with
      // a message written before the question came.
      if (busyRef.current) {
        const waiting = pendingCardRef.current;
        if (waiting?.interaction === "questions") setDraftHeldCard(waiting.key);
        dispatch({
          type: "held",
          text,
          context: selectedContext ?? null,
          attachment: attachment ?? null,
        });
        return;
      }
      busyRef.current = true;
      stopReading();
      openedByTakeRef.current = false;
      const press = pressRef.current;
      const restoreUnsent = () => {
        if (press !== pressRef.current) return;
        busyRef.current = false;
        const latest = stateRef.current;
        if (latest.draft === (typed ? "" : current.draft)) {
          dispatch({
            type: "held",
            text,
            context: latest.selectedContext ?? selectedContext ?? null,
            attachment: latest.attachment ?? attachment ?? null,
          });
        }
        dispatch({ type: "notice", notice: "chat.sendNotStarted" });
      };
      void (async () => {
        const image =
          typed || !extras ? ((await captureRequestScreen()) ?? attachment) : attachment;
        if (press !== pressRef.current) return true;
        dispatch({
          type: "submitted",
          typed,
          draft: current.draft,
          selectedContext: current.selectedContext,
          attachment: current.attachment,
        });
        return sendRef.current(text, {
          ...(selectedContext ? { selectedContext } : {}),
          ...(image ? { attachment: image } : {}),
        });
      })().then((sent) => {
        if (!sent) restoreUnsent();
      }, restoreUnsent);
    },
    [dispatch, refuseIfRestricted, stopReading]
  );

  const handleTranscript = useCallback(
    async (text: string, intent: AgentVoiceIntent) => {
      // One take at a time: a transcript is the latest take's.
      const take = takeRef.current;
      const dropped = () => take <= droppedTakeRef.current;
      if (dropped()) return;
      if (intent === "draft") {
        dispatch({ type: "appendDraft", text });
        return;
      }
      const pending = pressCaptureRef.current;
      pressCaptureRef.current = null;
      const press = pressRef.current;
      if (pending) await Promise.race([pending, delay(PRESS_CAPTURE_WAIT_MS)]);
      if (dropped() || take !== takeRef.current || press !== pressRef.current) return;
      pressRef.current += 1;
      const target = editTargetRef.current;
      editTargetRef.current = null;
      const extras = {
        selectedContext: stateRef.current.selectedContext,
        attachment: stateRef.current.attachment,
      };
      if (!target || (target.kind === "external" && extras.selectedContext?.text !== target.text)) {
        submit(text, false, extras);
        return;
      }
      const controller = new AbortController();
      const cancelReplacement = () => {
        if (target.kind === "external")
          void window.electronAPI?.cancelSelectionEdit?.(target.sessionId).catch(() => {});
      };
      controller.signal.addEventListener("abort", cancelReplacement, { once: true });
      selectionEditRef.current?.abort();
      selectionEditRef.current = controller;
      busyRef.current = true;
      setEditingSelection(true);
      const current = () => !controller.signal.aborted && !dropped();
      try {
        const replacement = await editSelectedText(text, target.text, {
          attachment: extras.attachment,
          appCategory: target.appCategory,
          signal: controller.signal,
        });
        if (!current()) return;
        if (replacement === null) {
          busyRef.current = chatBusyRef.current;
          submit(text, false, {
            ...extras,
            selectedContext: extras.selectedContext ?? { text: target.text, sourceMessageId: "" },
          });
          return;
        }
        if (target.kind === "approval") {
          const entry = useConnectorApprovalStore.getState().entries[target.key];
          const value =
            entry?.draft.fields?.[target.field] ??
            (target.field === "body" ? entry?.draft.body : undefined);
          if (
            !entry ||
            entry.actionId !== target.actionId ||
            entry.reconnect ||
            (entry.state !== "pending" && !entry.awaitingRetry) ||
            value !== target.draftValue
          ) {
            dispatch({ type: "notice", notice: "hooks.audioRecording.selectionEditing.changed" });
            return;
          }
          const edited =
            target.value.slice(0, target.start) + replacement + target.value.slice(target.end);
          const fieldValue = target.field === "subject" ? edited.replace(/[\r\n]+/g, " ") : edited;
          updateApprovalDraft(
            target.key,
            entry.draft.fields ? { fields: { [target.field]: fieldValue } } : { body: fieldValue }
          );
        } else {
          const result = await window.electronAPI?.replaceSelectedText?.(
            target.sessionId,
            replacement,
            {
              restoreClipboard: true,
              allowClipboardFallback: false,
            }
          );
          if (!current()) return;
          if (!result?.success) {
            dispatch({ type: "held", text: replacement, context: null, attachment: null });
            dispatch({
              type: "notice",
              notice: "hooks.audioRecording.selectionEditing.notAppliedTitle",
            });
            return;
          }
        }
        dispatch({ type: "setContext", context: null });
        dispatch({ type: "setAttachment", attachment: null });
      } catch {
        if (current())
          dispatch({
            type: "notice",
            notice: "hooks.audioRecording.selectionEditing.reasoningFailed",
          });
      } finally {
        controller.signal.removeEventListener("abort", cancelReplacement);
        if (selectionEditRef.current === controller) {
          selectionEditRef.current = null;
          busyRef.current = chatBusyRef.current;
          setEditingSelection(false);
        }
      }
    },
    [dispatch, submit]
  );

  const voice = useAgentVoice({
    onTranscript: (text, intent) => void handleTranscript(text, intent),
    onEmpty: () => dispatch({ type: "notice", notice: "agentWindow.notices.nothingHeard" }),
    onError: () => dispatch({ type: "notice", notice: "agentWindow.notices.transcriptionFailed" }),
    onMicError: () => dispatch({ type: "notice", notice: "agentWindow.notices.micUnavailable" }),
  });
  const listening = voice.status === "recording" || voice.opening;
  const transcribing = voice.status === "transcribing";

  const nudge = useAnswerNudge({
    pendingKey: pendingCard?.id ?? null,
    compact: state.layout !== "modal",
    visible: state.visible,
    paused: listening || transcribing,
    onOpen: () => moveOnItsOwn({ type: "expand" }),
  });

  const surface = useAgentSurface({
    visible: state.visible,
    layout: state.layout,
    focus: surfaceFocus,
    ...(standalone ? { contentHeight: cardHeight } : {}),
    // Only the pill that reads "Waiting for answer", or a notice, needs the wider window.
    wide:
      state.layout === "pill" &&
      (state.notice !== null || (pendingCard !== null && !listening && !transcribing)),
  });

  // Another app's selection and a screenshot, read at the press, ride with
  // the request it starts.
  const capturePressContext = useCallback(
    (external: boolean, card: SelectionEditTarget | null) => {
      const press = ++pressRef.current;
      const isCurrent = () => press === pressRef.current;
      editTargetRef.current = card;
      if (external) dispatch({ type: "setContext", context: null });
      dispatch({ type: "setAttachment", attachment: null });
      const selection = Promise.resolve(
        external ? window.electronAPI?.captureSelectedText?.() : null
      )
        .then(async (capture) => {
          if (isCurrent() && capture?.status === "selected") {
            const target: SelectionEditTarget = {
              kind: "external",
              sessionId: capture.sessionId,
              text: capture.text,
              appCategory: null,
            };
            editTargetRef.current = target;
            dispatch({
              type: "setContext",
              context: { text: capture.text, sourceMessageId: "", source: "external" },
            });
            if (getSettings().toneStyleEnabled) {
              const category = await window.electronAPI
                ?.captureDictationAppCategory?.()
                .catch(() => null);
              if (isCurrent()) target.appCategory = category ?? null;
            }
          } else if (isCurrent() && capture && capture.status !== "none") {
            dispatch({
              type: "notice",
              notice:
                capture.status === "too_large"
                  ? "hooks.audioRecording.selectionEditing.tooLarge"
                  : "hooks.audioRecording.selectionEditing.unavailable",
            });
          }
        })
        .catch(() => {
          if (isCurrent())
            dispatch({
              type: "notice",
              notice: "hooks.audioRecording.selectionEditing.unavailable",
            });
        });
      const screenshot = captureRequestScreen().then((attachment) => {
        if (isCurrent() && attachment) dispatch({ type: "setAttachment", attachment });
      });
      pressCaptureRef.current = Promise.all([selection, screenshot]);
    },
    [dispatch]
  );

  const startListening = useCallback(
    async ({ external = false } = {}) => {
      if (refuseIfRestricted()) return;
      const card = external ? null : selectedApprovalField();
      // Only a selected draft field can be edited while its turn waits on Send.
      if ((busy && !card) || editingSelection || voice.status !== "idle" || voice.opening) return;
      if (voice.streamingOnlyProvider) {
        // A realtime-only provider can't transcribe a take: type instead.
        dispatch({ type: "useKeyboard" });
        return;
      }
      stopReading();
      capturePressContext(external, card);
      takeRef.current += 1;
      dispatch({ type: "useVoice" });
      if ((await voice.start()) === "refused") {
        dispatch({ type: "notice", notice: "agentWindow.notices.dictationActive" });
      }
    },
    [busy, capturePressContext, dispatch, editingSelection, refuseIfRestricted, stopReading, voice]
  );

  const { cancel: cancelTake } = voice;
  // The take belongs to the chat it was spoken in: opening another drops it.
  const dropTake = useCallback(() => {
    selectionEditRef.current?.abort();
    selectionEditRef.current = null;
    editTargetRef.current = null;
    setEditingSelection(false);
    busyRef.current = chatBusyRef.current;
    droppedTakeRef.current = takeRef.current;
    pressRef.current += 1;
    pressCaptureRef.current = null;
    dispatch({ type: "setAttachment", attachment: null });
    dispatch({ type: "setContext", context: null });
    cancelTake();
  }, [cancelTake, dispatch]);
  const stopRequest = useCallback(() => {
    if (selectionEditRef.current) dropTake();
    else cancelTurn();
  }, [cancelTurn, dropTake]);
  useEffect(
    () =>
      subscribeAuthBoundary(() => {
        dropTake();
        stopReading();
        dispatch({ type: "setDraft", draft: "" });
      }),
    [dispatch, dropTake, stopReading]
  );
  // Bumped when the user opens another chat, so the list starts again at the
  // newest message instead of wherever the previous chat was scrolled.
  const [openedChat, setOpenedChat] = useState(0);

  const newChat = useCallback(() => {
    stopReading();
    dropTake();
    setOpenedChat((count) => count + 1);
    startNewChat();
  }, [dropTake, startNewChat, stopReading]);

  const { hide: hideSurface } = surface;
  // A close starts a new chat (the old one stays in the list); Minimize keeps
  // the chat. It starts before the hide, so a command that reaches the window
  // meanwhile goes to the new chat, though the window still ends hidden.
  const close = useCallback(async () => {
    newChat();
    pressRef.current += 1;
    openedByTakeRef.current = false;
    setRefusal(null);
    await hideSurface();
    dispatch({ type: "hide" });
  }, [dispatch, hideSurface, newChat]);

  const handleHotkey = useCallback(
    ({ external }: { external: boolean }) => {
      if (refuseIfRestricted()) return;
      setRefusal(null);
      // The second press sends what was said.
      if (listening) {
        voice.stop("submit");
        return;
      }
      const current = stateRef.current;
      // A reply is running: show it, but don't listen over it.
      if (busy && (editingSelection || external || !selectedApprovalField())) {
        if (!current.visible) dispatch({ type: "show", layout: "modal", input: "voice" });
        return;
      }
      // The last take is about to be sent; main showed the window for nothing.
      if (voice.status === "transcribing") {
        if (!current.visible) void window.electronAPI?.agentWindowHide?.();
        return;
      }
      if (!current.visible) {
        openedByTakeRef.current = true;
        dispatch({ type: "show", layout: "pill", input: "voice" });
      }
      void startListening({ external });
    },
    [busy, dispatch, editingSelection, listening, refuseIfRestricted, startListening, voice]
  );

  const handleEscape = useCallback(() => {
    if (selectionEditRef.current) {
      dropTake();
      return;
    }
    if (listening) {
      dropTake();
      if (openedByTakeRef.current && stateRef.current.layout === "pill") void close();
      return;
    }
    if (busy) {
      stopRequest();
      return;
    }
    // Selected text (and the toolbar on it) goes first: a close starts a new chat.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      selection.removeAllRanges();
      return;
    }
    void close();
  }, [busy, close, dropTake, listening, stopRequest]);

  // Main's messages, read through a ref so each listener is registered once.
  const handlersRef = useRef({
    hotkey: handleHotkey,
    escape: handleEscape,
    open: (_layout: AgentWindowLayout) => {},
    command: (_command: AgentWindowCommand) => {},
    dismiss: () => {},
  });
  handlersRef.current = {
    hotkey: handleHotkey,
    escape: handleEscape,
    open: (layout) => {
      if (refuseIfRestricted()) return;
      setRefusal(null);
      // Typing shows no take: what was said so far starts the draft, as Keyboard does.
      if (listening) voice.stop("draft");
      openedByTakeRef.current = false;
      dispatch({ type: "show", layout, input: "keyboard" });
    },
    command: (command) => {
      if (refuseIfRestricted()) return;
      setRefusal(null);
      if (!stateRef.current.visible) dispatch({ type: "show", layout: "pill", input: "voice" });
      submit(command.text, false, {
        selectedContext: command.selectedContext
          ? { text: command.selectedContext.text, sourceMessageId: "", source: "external" }
          : null,
        attachment: command.attachment,
      });
    },
    dismiss: () => {
      newChat();
      pressRef.current += 1;
      setRefusal(null);
      surface.forgetBounds();
      dispatch({ type: "hide" });
    },
  };

  useEffect(() => {
    const api = window.electronAPI;
    const disposers = [
      api?.onAgentWindowHotkey?.((payload) => {
        setMovedAway(false);
        handlersRef.current.hotkey(payload);
      }),
      api?.onAgentWindowOpen?.(({ layout }) => {
        setMovedAway(false);
        handlersRef.current.open(layout);
      }),
      api?.onAgentWindowCommand?.((command) => {
        setMovedAway(false);
        handlersRef.current.command(command);
      }),
      api?.onAgentWindowDismiss?.(() => handlersRef.current.dismiss()),
      api?.onCancelHotkeyPressed?.(() => handlersRef.current.escape()),
    ];
    // Registered first, so nothing main sends once it hears this is missed.
    api?.agentWindowReady?.();
    return () => disposers.forEach((dispose) => dispose?.());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // An IME uses Esc to drop its composition.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      handlersRef.current.escape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // A file or link dropped on the window would navigate it away; only text
  // dropped into the composer is taken.
  useEffect(() => {
    const refuseDrop = (event: DragEvent) => {
      const textIntoComposer =
        event.target instanceof HTMLTextAreaElement && !event.dataTransfer?.types.includes("Files");
      if (!textIntoComposer) event.preventDefault();
    };
    document.addEventListener("dragover", refuseDrop);
    document.addEventListener("drop", refuseDrop);
    return () => {
      document.removeEventListener("dragover", refuseDrop);
      document.removeEventListener("drop", refuseDrop);
    };
  }, []);

  // Opening a chat (a fork, a switch, a new one) resets what the next request
  // carries: a fork made from selected text sends it with its first request.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    const pending = unsentForkContext(forkOrigin, messagesRef.current);
    dispatch({
      type: "setContext",
      context: pending ? { text: pending, sourceMessageId: "" } : null,
    });
  }, [conversationId, forkOrigin, dispatch]);

  const forkMessage = useCallback(
    async (messageId: string, selectedText?: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      if (!message) return;
      const forkId = await fork(message, selectedText, () => {
        stopReading();
        dropTake();
      });
      if (forkId === null) {
        dispatch({ type: "notice", notice: "chat.forkFailed" });
        return;
      }
      if (forkId === false) return;
      setOpenedChat((count) => count + 1);
    },
    [dispatch, dropTake, fork, stopReading]
  );

  const regenerate = useCallback(
    (message: Message) => {
      if (refuseIfRestricted()) return;
      stopReading();
      regenerateReply(message);
    },
    [refuseIfRestricted, regenerateReply, stopReading]
  );

  const followUp = useCallback(
    ({ messageId, text }: { messageId: string; text: string }) =>
      dispatch({ type: "setContext", context: { text, sourceMessageId: messageId } }),
    [dispatch]
  );

  const continueTurn = useCallback(() => {
    submit(t("agentMode.turn.continueMessage"), true, {});
  }, [submit, t]);

  const switchChat = useCallback(
    (id: number) => {
      // The chat already open: nothing to stop or drop.
      if (id === conversationId) return;
      void openChat(id, () => {
        stopReading();
        dropTake();
      }).then((opened) => {
        // False: another switch overtook this one and owns the list.
        if (opened === true) setOpenedChat((count) => count + 1);
        else if (opened === null) dispatch({ type: "notice", notice: "chat.openFailed" });
      });
    },
    [conversationId, dispatch, dropTake, openChat, stopReading]
  );

  const readAloudState = useMemo(
    () => ({
      available: readAloud.available,
      speakingId: readAloud.speakingId,
      toggle: readAloud.toggle,
    }),
    [readAloud.available, readAloud.speakingId, readAloud.toggle]
  );

  const handlePillAction = (button: AgentPillButton) => {
    switch (button) {
      case "expand":
        openedByTakeRef.current = false;
        nudge.cancel();
        dispatch({ type: "expand" });
        return;
      case "mic":
        void startListening();
        return;
      case "keyboard":
        // What was said so far becomes the start of the typed draft.
        if (listening) voice.stop("draft");
        openedByTakeRef.current = false;
        nudge.cancel();
        // A waiting card opens in the modal, with the composer to answer it.
        dispatch({ type: "useKeyboard", pending: Boolean(pendingCard) });
        return;
      case "stop":
        stopRequest();
        return;
      case "close":
        void close();
    }
  };

  const answerStarted =
    latest?.role === "assistant" && Boolean(latest.content || latest.toolCalls?.length);
  // In the modal an answer card is on screen with its own Send, so the pill
  // waits only on an interaction card; outside it, the pill waits on any card.
  // Either way it reads as at rest while an answer card waits or sends.
  const pillStatus = (placement: AgentPillPlacement): AgentPillStatus =>
    listening
      ? "listening"
      : transcribing
        ? "transcribing"
        : editingSelection
          ? "thinking"
          : pendingCard && (placement !== "modal" || pendingCard.interaction !== null)
            ? "waiting"
            : cardHolds
              ? "idle"
              : busy && !answerStarted
                ? "thinking"
                : busy
                  ? "streaming"
                  : "idle";
  // Full on an empty chat, while the user speaks into it too (modal-empty);
  // faint while a draft is typed into it, or while listening or working in a
  // chat; none at rest or while a card waits on the user.
  const glow: AgentModalGlow =
    messages.length === 0 && !refusal
      ? state.draft.trim()
        ? "soft"
        : "strong"
      : (listening || transcribing || busy) && !cardHolds
        ? "soft"
        : "none";
  const notice = state.notice ? t(state.notice) : null;
  const micHint = voice.streamingOnlyProvider
    ? t("agentMode.input.voiceDraftStreamingOnly")
    : undefined;
  const pendingContext = (compact: boolean) =>
    state.selectedContext && (
      <SelectedContextBlock
        text={state.selectedContext.text}
        source={state.selectedContext.source}
        onRemove={() => {
          editTargetRef.current = null;
          dispatch({ type: "setContext", context: null });
        }}
        compact={compact}
      />
    );

  const pill = (placement: "compact" | "typing" | "modal") => (
    <AgentPill
      controls={resolveAgentPillControls(placement, pillStatus(placement), Boolean(notice))}
      recording={voice.status === "recording"}
      readLevel={voice.readLevel}
      notice={placement === "typing" ? null : notice}
      micUnavailableHint={micHint}
      micDisabled={busy || transcribing}
      expandCue={placement === "compact" && nudge.cue}
      inModal={placement === "modal"}
      onAction={handlePillAction}
    />
  );

  // The composer's text answers the question on screen (D3); a key is never
  // typed here. A restored question shows only in the modal, so only the
  // modal's composer answers it.
  const cardFor = (inModal: boolean) => (inModal ? answerableCard : pendingCard);
  const answerQuestion = (key: string, text: string) => {
    answerWithText(key, text);
    dispatch({ type: "setDraft", draft: "" });
  };

  // The user starting on the waiting card (a click or a key in it, in the
  // modal or above the pill) uses up its timed opening.
  const engageCard = (target: EventTarget) => {
    const card =
      target instanceof Element
        ? target.closest("[data-interaction-card], [data-approval-card]")
        : null;
    const key =
      card?.getAttribute("data-interaction-card") ?? card?.getAttribute("data-approval-card");
    if (pendingCard && key === pendingCard.key) nudge.cancel();
  };

  const composer = (inModal: boolean) => {
    const card = cardFor(inModal);
    const answering = card?.interaction === "questions" && card.key !== draftHeldCard;
    return (
      <AgentComposer
        draft={state.draft}
        onDraftChange={(draft) => dispatch({ type: "setDraft", draft })}
        onSubmit={(text) =>
          card && answering ? answerQuestion(card.key, text) : submit(text, true)
        }
        placeholder={
          answering
            ? t("agentWindow.composer.answerPlaceholder")
            : inModal && card?.interaction
              ? // A connect, access, key or settings card above: answered there, never here.
                t("agentWindow.composer.cardPlaceholder")
              : inModal && messages.length > 0
                ? t("agentWindow.composer.followUpPlaceholder")
                : t("agentWindow.composer.placeholder")
        }
        busy={busy}
        answering={answering}
        onStop={editingSelection || offersStop ? stopRequest : undefined}
        onClose={inModal ? () => void close() : undefined}
        onMic={inModal ? () => void startListening() : undefined}
        micDisabled={busy || transcribing}
        micUnavailableHint={micHint}
        focused={
          surface.shown &&
          keyboardWanted &&
          (card?.interaction !== "apiKey" || state.draft.trim() !== "")
        }
        header={
          <>
            {chat.pickedSkill && (
              <div className="pb-2">
                <SkillChip name={chat.pickedSkill.displayName} onRemove={chat.removePickedSkill} />
              </div>
            )}
            {!inModal && state.selectedContext ? (
              <div className="pb-2">{pendingContext(true)}</div>
            ) : null}
          </>
        }
        className={inModal ? "min-h-21" : "agent-panel h-[145px] w-[510px]"}
      />
    );
  };

  const emptyState = refusal ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
      <BrandMarkIcon size={22} className="text-primary" />
      <p dir="auto">{t(refusal)}</p>
    </div>
  ) : state.input === "keyboard" && !forkOrigin?.parentTitle ? (
    // A fork with nothing of its own yet shows just its chip.
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <BrandMarkIcon size={22} className="text-primary" />
      <p className="text-lg font-medium text-foreground">{t("agentWindow.empty.title")}</p>
      <p className="text-sm text-muted-foreground">{t("agentWindow.empty.description")}</p>
    </div>
  ) : null;

  return (
    <div className="agent-window">
      <div
        className={cn(
          "agent-window-content flex h-full w-full flex-col items-center justify-end",
          (state.layout === "typing" || standalone) && "gap-3"
        )}
        data-shown={surface.shown}
        onPointerDown={(event) => {
          if (cardShown) setCardClicked(true);
          setMovedAway(false);
          engageCard(event.target);
        }}
        onKeyDown={(event) => engageCard(event.target)}
      >
        {state.layout === "modal" ? (
          <AgentModal
            bare={messages.length === 0 && state.input === "voice" && !refusal}
            glow={glow}
            conversationId={conversationId}
            onNewChat={newChat}
            onSelectChat={switchChat}
            onCollapse={() => dispatch({ type: "collapse", pending: Boolean(pendingCard) })}
            footer={
              <div className="flex flex-col items-center gap-2">
                {state.input === "keyboard" && notice && (
                  <p className="self-start px-1 text-xs text-muted-foreground">{notice}</p>
                )}
                {state.selectedContext && <div className="w-full">{pendingContext(false)}</div>}
                {state.input === "keyboard" ? (
                  <div className="w-full">{composer(true)}</div>
                ) : (
                  pill("modal")
                )}
              </div>
            }
          >
            <AgentMessageList
              key={openedChat}
              messages={refusal ? [] : shown}
              forkOrigin={forkOrigin}
              onOpenParent={switchChat}
              busy={busy}
              readAloud={readAloudState}
              onRegenerate={regenerate}
              onFork={forkMessage}
              onFollowUp={followUp}
              onContinue={continueTurn}
              emptyState={emptyState}
            />
          </AgentModal>
        ) : state.layout === "typing" ? (
          <>
            {/* A command held while a card waits brings this back; typing here
                stops the timed opening. */}
            <div onKeyDown={nudge.cancel}>{composer(false)}</div>
            {pill("typing")}
          </>
        ) : standalone && pendingCard ? (
          <>
            {/* The same card as in the modal, so what the user picked carries
                over. Moving the pointer over it stops the timed opening, as
                starting on it does. Neither focus (the window can be given it)
                nor a card laid out under a resting cursor counts: Chromium
                replays that position as a pointerenter with no movement. */}
            <div
              ref={cardFrameRef}
              onPointerMove={(event) => {
                if (event.movementX || event.movementY) nudge.cancel();
              }}
              className="agent-chat-scroll flex max-h-[400px] w-[420px] shrink-0 flex-col overflow-y-auto rounded-2xl border border-border/50 shadow-[var(--shadow-card)] *:my-0"
            >
              <ToolCallCard messageId={pendingCard.messageId} toolCall={pendingCard.toolCall} />
            </div>
            {pill("compact")}
          </>
        ) : (
          pill("compact")
        )}
      </div>
      {/* The assistant edits notes from here; its Undo shows once this window has focus. */}
      <AssistantNoteUndoListener />
    </div>
  );
}
