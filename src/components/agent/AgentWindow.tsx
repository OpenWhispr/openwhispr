import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import AssistantNoteUndoListener from "../notes/AssistantNoteUndoListener";
import { mirrorActiveAccountScope } from "../../lib/accountScopeMirror";
import { usePolicyStore } from "../../stores/policyStore";
import { isAgentAllowed, isScreenContextAllowed } from "../../stores/policyRules";
import { getSettings } from "../../stores/settingsStore";
import { resolveAgentAccessRefusal } from "../../helpers/agentAccessPolicy";
import type { ChatImageAttachment, Message } from "../chat/types";
import { unsentForkContext, type AgentSelectionContext } from "../../utils/agentSelectionContext";
import type { AgentWindowCommand, AgentWindowLayout } from "../../types/electron";
import {
  agentWindowReducer,
  awaitsTypedAnswer,
  INITIAL_AGENT_WINDOW_STATE,
  resolveAgentPillControls,
  type AgentPillButton,
  type AgentPillStatus,
  type AgentWindowAction,
  type AgentWindowState,
} from "./agentWindowState";
import { useAgentSurface } from "./useAgentSurface";
import { useAgentVoice, type AgentVoiceIntent } from "./useAgentVoice";
import { useAgentChat } from "./useAgentChat";
import { useReadAloud } from "./useReadAloud";
import { AgentPill } from "./AgentPill";
import { AgentComposer } from "./AgentComposer";
import { AgentModal } from "./AgentModal";
import { AgentMessageList } from "./AgentMessages";
import { SkillChip } from "../chat/SkillChip";
import { SelectedContextBlock } from "./AgentContext";

// How long a spoken request waits for the press-time selection and screenshot.
const PRESS_CAPTURE_WAIT_MS = 3000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RequestExtras {
  selectedContext?: AgentSelectionContext | null;
  attachment?: ChatImageAttachment | null;
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

  const onResponseContent = useCallback(() => {
    // A spoken request thinks in the pill; the answer shows in the modal.
    if (stateRef.current.layout !== "modal") dispatch({ type: "expand" });
  }, [dispatch]);
  const onRegenerateFailed = useCallback(
    () => dispatch({ type: "notice", notice: "agentWindow.notices.regenerateFailed" }),
    [dispatch]
  );
  const chat = useAgentChat({ onResponseContent, onRegenerateFailed });
  const {
    busy,
    cancel: cancelTurn,
    conversationId,
    fork,
    forkOrigin,
    messages,
    newChat: startNewChat,
    regenerate: regenerateReply,
    switchChat: openChat,
  } = chat;
  // A new function every render; read through a ref so callbacks stay stable.
  const sendRef = useRef(chat.send);
  sendRef.current = chat.send;
  const readAloud = useReadAloud(i18n.language);
  const { stop: stopReading } = readAloud;

  // A click in the modal after a spoken request may be into a card's field.
  const [modalClicked, setModalClicked] = useState(false);
  const modalShown = state.visible && state.layout === "modal";
  useEffect(() => {
    if (!modalShown) setModalClicked(false);
  }, [modalShown]);
  const surfaceFocus =
    state.layout !== "pill" &&
    (state.input === "keyboard" ||
      (state.layout === "modal" && (modalClicked || awaitsTypedAnswer(messages))));
  const surface = useAgentSurface({
    visible: state.visible,
    layout: state.layout,
    focus: surfaceFocus,
  });

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
      const current = stateRef.current;
      const selectedContext = extras ? extras.selectedContext : current.selectedContext;
      const attachment = extras ? extras.attachment : current.attachment;
      // A wake-word command can arrive while a reply runs; it waits rather
      // than being lost or cutting the reply off.
      if (busyRef.current) {
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
      dispatch({ type: "submitted", typed });
      void sendRef.current(text, {
        ...(selectedContext ? { selectedContext } : {}),
        ...(attachment ? { attachment } : {}),
      });
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
      if (pending) await Promise.race([pending, delay(PRESS_CAPTURE_WAIT_MS)]);
      if (dropped()) return;
      submit(text, false);
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

  // Another app's selection and a screenshot, read at the press, ride with
  // the request it starts.
  const capturePressContext = useCallback(() => {
    const press = ++pressRef.current;
    const isCurrent = () => press === pressRef.current;
    const selection = Promise.resolve(window.electronAPI?.captureSelectedText?.())
      .then((capture) => {
        if (isCurrent() && capture?.status === "selected") {
          dispatch({
            type: "setContext",
            context: { text: capture.text, sourceMessageId: "", source: "external" },
          });
        }
      })
      .catch(() => {});
    const screenshot =
      getSettings().voiceAgentScreenContext && isScreenContextAllowed(usePolicyStore.getState())
        ? Promise.resolve(window.electronAPI?.captureScreenContext?.())
            .then((image) => {
              if (isCurrent() && image) {
                dispatch({
                  type: "setAttachment",
                  attachment: { image: image.data, mediaType: image.mediaType },
                });
              }
            })
            .catch(() => {})
        : null;
    pressCaptureRef.current = Promise.all([selection, screenshot]);
  }, [dispatch]);

  const startListening = useCallback(async () => {
    if (refuseIfRestricted()) return;
    // One take at a time, and none over a reply.
    if (busy || voice.status !== "idle" || voice.opening) return;
    if (voice.streamingOnlyProvider) {
      // A realtime-only provider can't transcribe a take: type instead.
      dispatch({ type: "useKeyboard" });
      return;
    }
    takeRef.current += 1;
    dispatch({ type: "useVoice" });
    if ((await voice.start()) === "refused") {
      dispatch({ type: "notice", notice: "agentWindow.notices.dictationActive" });
    }
  }, [busy, dispatch, refuseIfRestricted, voice]);

  const { cancel: cancelTake } = voice;
  // The take belongs to the chat it was spoken in: opening another drops it.
  const dropTake = useCallback(() => {
    droppedTakeRef.current = takeRef.current;
    cancelTake();
  }, [cancelTake]);
  const { hide: hideSurface } = surface;
  const close = useCallback(async () => {
    dropTake();
    pressRef.current += 1;
    openedByTakeRef.current = false;
    cancelTurn();
    stopReading();
    setRefusal(null);
    await hideSurface();
    dispatch({ type: "hide" });
  }, [cancelTurn, dispatch, dropTake, hideSurface, stopReading]);

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
      if (busy) {
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
      if (external) capturePressContext();
      void startListening();
    },
    [busy, capturePressContext, dispatch, listening, refuseIfRestricted, startListening, voice]
  );

  const handleEscape = useCallback(() => {
    if (listening) {
      cancelTake();
      if (openedByTakeRef.current && stateRef.current.layout === "pill") void close();
      return;
    }
    if (busy) {
      cancelTurn();
      return;
    }
    void close();
  }, [busy, cancelTake, cancelTurn, close, listening]);

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
      dropTake();
      pressRef.current += 1;
      cancelTurn();
      stopReading();
      setRefusal(null);
      surface.forgetBounds();
      dispatch({ type: "hide" });
    },
  };

  useEffect(() => {
    const api = window.electronAPI;
    const disposers = [
      api?.onAgentWindowHotkey?.((payload) => handlersRef.current.hotkey(payload)),
      api?.onAgentWindowOpen?.(({ layout }) => handlersRef.current.open(layout)),
      api?.onAgentWindowCommand?.((command) => handlersRef.current.command(command)),
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

  // Bumped when the user opens another chat, so the list starts again at the
  // newest message instead of wherever the previous chat was scrolled.
  const [openedChat, setOpenedChat] = useState(0);

  const forkMessage = useCallback(
    async (messageId: string, selectedText?: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      if (!message) return;
      stopReading();
      dropTake();
      if ((await fork(message, selectedText)) === null) {
        dispatch({ type: "notice", notice: "chat.forkFailed" });
        return;
      }
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
      stopReading();
      dropTake();
      void openChat(id).then((opened) => {
        // False: another switch overtook this one and owns the list.
        if (opened !== false) setOpenedChat((count) => count + 1);
      });
    },
    [conversationId, dropTake, openChat, stopReading]
  );

  const newChat = useCallback(() => {
    stopReading();
    dropTake();
    setOpenedChat((count) => count + 1);
    startNewChat();
  }, [dropTake, startNewChat, stopReading]);

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
        dispatch({ type: "expand" });
        return;
      case "mic":
        void startListening();
        return;
      case "keyboard":
        // What was said so far becomes the start of the typed draft.
        if (listening) voice.stop("draft");
        openedByTakeRef.current = false;
        dispatch({ type: "useKeyboard" });
        return;
      case "stop":
        cancelTurn();
        return;
      case "close":
        void close();
    }
  };

  const latest = messages.at(-1);
  const answerStarted =
    latest?.role === "assistant" && Boolean(latest.content || latest.toolCalls?.length);
  const transcribing = voice.status === "transcribing";
  const pillStatus: AgentPillStatus = listening
    ? "listening"
    : transcribing
      ? "transcribing"
      : busy && !answerStarted
        ? "thinking"
        : busy
          ? "streaming"
          : "idle";
  const notice = state.notice ? t(state.notice) : null;
  const micHint = voice.streamingOnlyProvider
    ? t("agentMode.input.voiceDraftStreamingOnly")
    : undefined;
  const pendingContext = state.selectedContext && (
    <SelectedContextBlock
      text={state.selectedContext.text}
      source={state.selectedContext.source}
      onRemove={() => dispatch({ type: "setContext", context: null })}
    />
  );

  const pill = (placement: "compact" | "typing" | "modal") => (
    <AgentPill
      controls={resolveAgentPillControls(placement, pillStatus, Boolean(notice))}
      recording={voice.status === "recording"}
      readLevel={voice.readLevel}
      notice={placement === "typing" ? null : notice}
      micUnavailableHint={micHint}
      micDisabled={busy || transcribing}
      onAction={handlePillAction}
    />
  );

  const composer = (inModal: boolean) => (
    <AgentComposer
      draft={state.draft}
      onDraftChange={(draft) => dispatch({ type: "setDraft", draft })}
      onSubmit={(text) => submit(text, true)}
      placeholder={
        inModal && messages.length > 0
          ? t("agentWindow.composer.followUpPlaceholder")
          : t("agentWindow.composer.placeholder")
      }
      busy={busy}
      onStop={cancelTurn}
      onClose={inModal ? () => void close() : undefined}
      onMic={inModal ? () => void startListening() : undefined}
      micDisabled={busy || transcribing}
      micUnavailableHint={micHint}
      focused={surface.shown && surfaceFocus}
      header={
        <>
          {chat.pickedSkill && (
            <div className="pb-2">
              <SkillChip name={chat.pickedSkill.displayName} onRemove={chat.removePickedSkill} />
            </div>
          )}
          {!inModal && pendingContext ? <div className="pb-2">{pendingContext}</div> : null}
        </>
      }
      className={inModal ? "min-h-[92px]" : "h-[145px] w-[510px]"}
    />
  );

  const emptyState = refusal ? (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
      <BrandMarkIcon size={22} className="text-primary" />
      <p dir="auto">{t(refusal)}</p>
    </div>
  ) : state.input === "keyboard" ? (
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
          state.layout === "typing" && "gap-3"
        )}
        data-shown={surface.shown}
        onPointerDown={modalShown ? () => setModalClicked(true) : undefined}
      >
        {state.layout === "modal" ? (
          <AgentModal
            bare={messages.length === 0 && state.input === "voice" && !refusal}
            conversationId={conversationId}
            onNewChat={newChat}
            onSelectChat={switchChat}
            onCollapse={() => dispatch({ type: "collapse" })}
            footer={
              <div className="flex flex-col items-center gap-2">
                {state.input === "keyboard" && notice && (
                  <p className="self-start px-1 text-xs text-muted-foreground">{notice}</p>
                )}
                {pendingContext && <div className="w-full">{pendingContext}</div>}
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
              messages={refusal ? [] : messages}
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
            {composer(false)}
            {pill("typing")}
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
