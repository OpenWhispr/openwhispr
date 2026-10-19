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
  const chat = useAgentChat({ onResponseContent });
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

  const surfaceFocus = state.input === "keyboard" && state.layout !== "pill";
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
  // A take whose transcript must not be sent (closed, dismissed).
  const dropTranscriptRef = useRef(false);

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
      if (dropTranscriptRef.current) return;
      if (intent === "draft") {
        dispatch({ type: "appendDraft", text });
        return;
      }
      const pending = pressCaptureRef.current;
      pressCaptureRef.current = null;
      if (pending) await Promise.race([pending, delay(PRESS_CAPTURE_WAIT_MS)]);
      if (dropTranscriptRef.current) return;
      submit(text, false);
    },
    [dispatch, submit]
  );

  const voice = useAgentVoice({
    onTranscript: (text, intent) => void handleTranscript(text, intent),
    onEmpty: () => dispatch({ type: "notice", notice: "agentWindow.notices.nothingHeard" }),
    onError: () => dispatch({ type: "notice", notice: "agentWindow.notices.transcriptionFailed" }),
  });
  const listening = voice.status === "recording" || voice.opening;

  // Another app's selection and a screenshot, read at the press, ride with
  // the request it starts.
  const capturePressContext = useCallback(() => {
    const press = ++pressRef.current;
    const isCurrent = () => press === pressRef.current;
    const selection = Promise.resolve(
      window.electronAPI?.captureSelectedText?.({ probeEditable: false })
    )
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
    if (voice.streamingOnlyProvider) {
      // A realtime-only provider can't transcribe a take: type instead.
      dispatch({ type: "useKeyboard" });
      return;
    }
    dropTranscriptRef.current = false;
    dispatch({ type: "useVoice" });
    if ((await voice.start()) === "refused") {
      dispatch({ type: "notice", notice: "agentWindow.notices.dictationActive" });
    }
  }, [dispatch, refuseIfRestricted, voice]);

  const { cancel: cancelTake } = voice;
  const { hide: hideSurface } = surface;
  const close = useCallback(async () => {
    dropTranscriptRef.current = true;
    pressRef.current += 1;
    openedByTakeRef.current = false;
    cancelTake();
    cancelTurn();
    stopReading();
    setRefusal(null);
    await hideSurface();
    dispatch({ type: "hide" });
  }, [cancelTake, cancelTurn, dispatch, hideSurface, stopReading]);

  const handleHotkey = useCallback(
    ({ external }: { external: boolean }) => {
      if (refuseIfRestricted()) return;
      setRefusal(null);
      // The second press sends what was said.
      if (listening) {
        voice.stop("submit");
        return;
      }
      if (voice.status === "transcribing" || busy) return;
      const current = stateRef.current;
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
      dropTranscriptRef.current = true;
      cancelTake();
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
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      handlersRef.current.escape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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
      setOpenedChat((count) => count + 1);
      if ((await fork(message, selectedText)) === null) {
        dispatch({ type: "notice", notice: "chat.forkFailed" });
      }
    },
    [dispatch, fork, stopReading]
  );

  const regenerate = useCallback(
    (message: Message) => {
      stopReading();
      regenerateReply(message);
    },
    [regenerateReply, stopReading]
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
      stopReading();
      setOpenedChat((count) => count + 1);
      void openChat(id);
    },
    [openChat, stopReading]
  );

  const newChat = useCallback(() => {
    stopReading();
    setOpenedChat((count) => count + 1);
    startNewChat();
  }, [startNewChat, stopReading]);

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
  const pillStatus: AgentPillStatus = listening
    ? "listening"
    : voice.status === "transcribing" || (busy && !answerStarted)
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
      micUnavailableHint={micHint}
      focused={surface.shown && surfaceFocus}
      header={!inModal && pendingContext ? <div className="pb-2">{pendingContext}</div> : null}
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
