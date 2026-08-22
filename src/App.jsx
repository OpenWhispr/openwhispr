import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, X } from "lucide-react";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useAssistantPanel } from "./hooks/useAssistantPanel";
import { useLiveTranscriptPanel } from "./hooks/useLiveTranscriptPanel";
import { useMainWindowSizeOwner } from "./hooks/useMainWindowSizeOwner";
import { useMainProcessNotifications } from "./hooks/useMainProcessNotifications";
import { useWindowResizeCompensation } from "./hooks/useWindowResizeCompensation";
import { useSettingsStore } from "./stores/settingsStore";
import { getBaseLanguageCode, getLanguageLabel } from "./utils/languageSupport";
import { getCachedPlatform } from "./utils/platform";

const platform = getCachedPlatform();
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { VoicePill } from "./components/dictation/VoicePill";
import { AssistantPanel } from "./components/dictation/AssistantPanel";
import { LiveTranscriptPanel } from "./components/dictation/LiveTranscriptPanel";
import { VoiceModePanelCore } from "./components/dictation/VoiceModePanelCore";
import { PillTooltip } from "./components/dictation/PillTooltip";
import { PillCommandMenu } from "./components/dictation/PillCommandMenu";
import { createMainWindowResizeCoordinator } from "./utils/mainWindowResizeCoordinator";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  getListeningEntranceTimeline,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveLiveTranscriptEntrancePresentation,
  resolveAssistantFooterPresentation,
  resolveAgentModeActive,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolveVoicePanelCorePresentation,
  resolveVoicePillDock,
  resolveVoicePillInteraction,
  isVoicePillActivationKey,
  shouldActivateVoicePill,
  shouldOfferLiveTranscriptReopen,
} from "./helpers/voicePillPresentation";

const formatPillHotkeyLabel = (value) =>
  formatHotkeyListLabel(value)
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();

const UNMOUNTED_RESIZE = {
  success: false,
  superseded: true,
  message: "Resize coordinator not mounted",
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const commandMenuRef = useRef(null);
  const languageMenuRef = useRef(null);
  const languagePopupRef = useRef(null);
  const { toast, dismiss, toastCount, dictationErrorActionCount, dismissByPresentation } =
    useToast();
  const { t } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const setPreferredLanguage = useSettingsStore((s) => s.setPreferredLanguage);
  const preferredLanguages = useSettingsStore((s) => s.preferredLanguages);

  // Effective multi-select set: falls back to the single active language for
  // users who never selected multiple.
  const languageOptions = React.useMemo(
    () => (preferredLanguages.length > 0 ? preferredLanguages : [preferredLanguage]),
    [preferredLanguages, preferredLanguage]
  );
  const showLanguageSwitcher = languageOptions.length > 1;
  const activeLanguageLabel = React.useMemo(
    () => getLanguageLabel(preferredLanguage),
    [preferredLanguage]
  );
  const beamTheme = useSettingsStore((s) => s.theme);
  const prevAutoHideRef = useRef(floatingIconAutoHide);
  const [voiceHorizontalDirection, setVoiceHorizontalDirection] = useState(() =>
    resolveVoiceHorizontalDirection(panelStartPosition)
  );
  const [mainWindowHorizontalDirection, setMainWindowHorizontalDirection] = useState(null);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);
  const dismissDictationError = React.useCallback(
    () => dismissByPresentation("dictation-error"),
    [dismissByPresentation]
  );

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    let disposed = false;
    const applyDirection = (direction) => {
      if (!disposed && (direction === "left" || direction === "right")) {
        setMainWindowHorizontalDirection(direction);
      }
    };
    const unsubscribe =
      window.electronAPI?.onMainWindowHorizontalDirectionChanged?.(applyDirection);
    const initialDirection = window.electronAPI?.getMainWindowHorizontalDirection?.();
    initialDirection?.then(applyDirection).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useWindowResizeCompensation();
  useMainProcessNotifications({ toast, dismiss, t });

  const agentAllowed = usePolicyStore(isAgentAllowed);

  const mainWindowResizeCoordinatorRef = useRef(null);
  useEffect(() => {
    // Created in the effect, not lazily during render: React StrictMode's
    // dev-only setup→cleanup→setup cycle then disposes and recreates it
    // instead of disposing the only instance for the rest of the session.
    const coordinator = createMainWindowResizeCoordinator({
      resizeMainWindow: (sizeKey) => window.electronAPI?.resizeMainWindow?.(sizeKey),
      resizeAssistantWindowToContent: (height) =>
        window.electronAPI?.resizeAssistantWindowToContent?.(height),
    });
    mainWindowResizeCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (mainWindowResizeCoordinatorRef.current === coordinator) {
        mainWindowResizeCoordinatorRef.current = null;
      }
    };
  }, []);

  const requestMainWindowSize = React.useCallback(
    (sizeKey) =>
      mainWindowResizeCoordinatorRef.current?.resizeMainWindow(sizeKey) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );
  const resizeLiveTranscriptToContent = React.useCallback(
    (height) =>
      mainWindowResizeCoordinatorRef.current?.resizeAssistantWindowToContent(height) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );

  const onPanelOpened = React.useCallback(() => setIsHovered(false), []);

  // The assistant panel and the recording pipeline reference each other
  // (voice commands flow in, closing the panel cancels a recording), and the
  // live transcript needs recording state as effect deps. These refs break the
  // render-order cycle; both are read only at event time, never during render.
  const recordingControlsRef = useRef({});
  const liveTranscriptApiRef = useRef(null);

  const assistant = useAssistantPanel({
    requestMainWindowSize,
    dictationErrorActionCount,
    recordingControlsRef,
    onPanelOpened,
  });
  const { noteDictationError, openRef: assistantOpenRef } = assistant;

  const handleDictationError = React.useCallback(
    (options = {}) => {
      noteDictationError(options);
      liveTranscriptApiRef.current?.dismissForError();
    },
    [noteDictationError]
  );

  // Switching is allowed mid-recording: whisper and batch cloud read the
  // language at transcription time (the switch applies to the recording in
  // progress) and Parakeet models auto-detect, ignoring the hint either way.
  // The chunked live preview captures its language at session start, so
  // retarget it too. The exception is cloud realtime streaming, which fixes
  // its language when the session starts — tell the user the switch only
  // takes effect from the next dictation.
  const handlePanelLanguageSelect = React.useCallback(
    (code) => {
      setPreferredLanguage(code);
      window.electronAPI?.updateDictationPreviewLanguage?.(getBaseLanguageCode(code) ?? null);
      if (isStreaming) {
        toast({
          title: t("app.toasts.streamingLanguageSwitch.title"),
          description: t("app.toasts.streamingLanguageSwitch.description", {
            language: getLanguageLabel(code),
          }),
          duration: 6000,
        });
      }
    },
    [setPreferredLanguage, isStreaming, toast, t]
  );

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!assistantOpenRef.current && !liveTranscriptApiRef.current?.openRef.current) {
      setWindowInteractivity(false);
    }
  }, [assistantOpenRef, setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    isStreaming,
    isAssistantVoice,
    isPreparing,
    isStopping,
    micCaptureStatus,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onDemoEvent: (event) => {
      // Demo sessions only exist while onboarding is incomplete — skip the IPC otherwise.
      if (localStorage.getItem("onboardingCompleted") === "true") return;
      window.electronAPI?.publishOnboardingDemoEvent?.(event);
    },
    onAssistantCommand: assistant.handleCommand,
    dismissDictationError,
    onDictationError: handleDictationError,
    getAssistantSelectionContext: assistant.getSelectionContext,
    onShowTranscript: (text) => liveTranscriptApiRef.current?.showFinalText(text),
  });
  const isVisuallyProcessing = isProcessing || isPreparing || isStopping;

  useLayoutEffect(() => {
    recordingControlsRef.current = {
      isAssistantVoice,
      isRecording,
      isPreparing,
      isProcessing,
      cancelRecording,
      cancelProcessing,
    };
  });

  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent: resizeLiveTranscriptToContent,
    assistantOpenRef,
    onWillOpen: onPanelOpened,
    isRecording,
    isProcessing,
    isAssistantVoice,
  });

  useLayoutEffect(() => {
    liveTranscriptApiRef.current = liveTranscript;
  });

  // Must run before the size owner's ladder effect below: the error teardown
  // drops the live transcript's open ref, which the ladder reads this commit.
  useEffect(() => {
    if (dictationErrorActionCount > 0) handleDictationError();
  }, [dictationErrorActionCount, handleDictationError]);

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked =
    isRecording || isVisuallyProcessing || assistant.mounted || liveTranscript.mounted;
  useLayoutEffect(() => {
    if (voiceDirectionLocked) return;
    setVoiceHorizontalDirection(
      mainWindowHorizontalDirection ?? resolveVoiceHorizontalDirection(panelStartPosition)
    );
  }, [mainWindowHorizontalDirection, panelStartPosition, voiceDirectionLocked]);

  const { beginThinking: beginAssistantThinking } = assistant;
  useEffect(() => {
    if (isAssistantVoice && isProcessing && assistantOpenRef.current) {
      beginAssistantThinking();
    }
  }, [isAssistantVoice, isProcessing, assistantOpenRef, beginAssistantThinking]);

  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording,
    isProcessing: isVisuallyProcessing,
    isAssistantVoice,
    assistantThinking: assistant.thinking || assistant.busy,
  });
  const [listeningEntrancePhase, setListeningEntrancePhase] = useState("idle");
  useLayoutEffect(() => {
    if (!isRecording) {
      setListeningEntrancePhase("idle");
      return;
    }

    setListeningEntrancePhase("thinking");
    const timeline = getListeningEntranceTimeline();
    const expansionTimer = setTimeout(
      () => setListeningEntrancePhase("expanding"),
      timeline.expandAtMs
    );
    const settledTimer = setTimeout(
      () => setListeningEntrancePhase("settled"),
      timeline.settleAtMs
    );
    const waveformTimer = setTimeout(
      () => setListeningEntrancePhase("waveform"),
      timeline.waveformAtMs
    );

    return () => {
      clearTimeout(expansionTimer);
      clearTimeout(settledTimer);
      clearTimeout(waveformTimer);
    };
  }, [isRecording]);
  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording,
    phase: listeningEntrancePhase,
  });
  const isCompactPill = isRecording ? listeningEntrance.compactPill : voiceActivity.compactPill;

  // Wider rest size so the hover language chip isn't clipped. On Windows the
  // panel never becomes click-through (see setMainWindowInteractivity), so the
  // extra width at rest would be an invisible click-eating strip beside the
  // mic — rest at the compact size there and widen only while hovered (or
  // while the chip's menu keeps the chip mounted), which is when the chip
  // mounts anyway.
  const wantsLanguageWidth =
    showLanguageSwitcher && (platform !== "win32" || isHovered || isLanguageMenuOpen);

  const { dictationErrorPillHandoffActive } = useMainWindowSizeOwner({
    requestMainWindowSize,
    dictationErrorActionCount,
    toastCount,
    isCommandMenuOpen,
    isLanguageMenuOpen,
    commandMenuIncludesLanguage: isCommandMenuOpen && showLanguageSwitcher,
    wantsLanguageWidth,
    isCompactPill,
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    assistantOpenRef,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
    liveTranscriptOpenRef: liveTranscript.openRef,
  });

  useEffect(() => {
    if (
      isCommandMenuOpen ||
      isLanguageMenuOpen ||
      toastCount > 0 ||
      assistant.mounted ||
      liveTranscript.mounted
    ) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [
    isCommandMenuOpen,
    isLanguageMenuOpen,
    isHovered,
    toastCount,
    assistant.mounted,
    liveTranscript.mounted,
    setWindowInteractivity,
  ]);

  // The language chip (and its open menu) disappears during processing —
  // close the menu state too, or the invisible panel would keep window focus
  // and the enlarged menu size, then reopen the menu unprompted afterwards.
  useEffect(() => {
    if (isVisuallyProcessing || assistant.mounted || liveTranscript.mounted) {
      setIsLanguageMenuOpen(false);
    }
  }, [isVisuallyProcessing, assistant.mounted, liveTranscript.mounted]);

  // Keep toasts stacked above an open menu instead of covering it
  // (the toast viewport in Toast.tsx reads --toast-viewport-bottom)
  useLayoutEffect(() => {
    const menuTops = [];
    if (isLanguageMenuOpen && languagePopupRef.current) {
      menuTops.push(languagePopupRef.current.getBoundingClientRect().top);
    }
    if (isCommandMenuOpen && commandMenuRef.current) {
      menuTops.push(commandMenuRef.current.getBoundingClientRect().top);
    }
    if (menuTops.length > 0) {
      document.documentElement.style.setProperty(
        "--toast-viewport-bottom",
        `${Math.round(window.innerHeight - Math.min(...menuTops) + 8)}px`
      );
    } else {
      document.documentElement.style.removeProperty("--toast-viewport-bottom");
    }
    return () => document.documentElement.style.removeProperty("--toast-viewport-bottom");
  }, [isCommandMenuOpen, isLanguageMenuOpen, languageOptions]);

  // The panel window is non-focusable, so a click landing in another app is
  // invisible to the renderer and would leave an open menu dangling. While a
  // menu is open the main process makes the window focusable and focused, so
  // that click blurs the window and the renderer closes the menu on blur.
  // Keyed on the derived boolean: switching directly between the two menus
  // must not release focus in between, or the transient blur event would
  // close the menu that just opened.
  const hasOpenMenu = isCommandMenuOpen || isLanguageMenuOpen;
  useEffect(() => {
    window.electronAPI?.setMainWindowMenuFocus?.(hasOpenMenu);
    return () => {
      if (hasOpenMenu) {
        window.electronAPI?.setMainWindowMenuFocus?.(false);
      }
    };
  }, [hasOpenMenu]);

  // Close the menus when the window loses focus (e.g. a click landing in
  // another app) — the window holds focus while a menu is open, see above.
  useEffect(() => {
    if (!hasOpenMenu) return;
    const handleWindowBlur = () => {
      setIsCommandMenuOpen(false);
      setIsLanguageMenuOpen(false);
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [hasOpenMenu]);

  useEffect(() => {
    if (isRecording && dictationErrorActionCount > 0) {
      dismissByPresentation("dictation-error");
    }
  }, [isRecording, dictationErrorActionCount, dismissByPresentation]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording();
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (
      floatingIconAutoHide &&
      !isRecording &&
      !isVisuallyProcessing &&
      toastCount === 0 &&
      !dictationErrorPillHandoffActive &&
      !assistant.mounted &&
      !liveTranscript.mounted
    ) {
      // Delay briefly so processing can start after recording stops without a flash
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [
    isRecording,
    isVisuallyProcessing,
    floatingIconAutoHide,
    toastCount,
    dictationErrorPillHandoffActive,
    assistant.mounted,
    liveTranscript.mounted,
  ]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // The assistant panel owns Escape while it is open.
        if (assistant.mounted) return;
        if (isLanguageMenuOpen) {
          setIsLanguageMenuOpen(false);
        } else if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else if (isRecording) {
          cancelRecording();
        } else if (isPreparing) {
          cancelRecording();
        } else if (isProcessing) {
          cancelProcessing();
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [
    isCommandMenuOpen,
    isLanguageMenuOpen,
    assistant.mounted,
    isRecording,
    isPreparing,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isVisuallyProcessing) return "processing";
    if (isHovered && !isRecording && !isVisuallyProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicTooltip = () => {
    switch (micState) {
      case "recording":
        return t("app.mic.recording");
      case "unavailable":
        return t("app.mic.waitingForMicrophone");
      case "processing":
        return t("app.mic.processing");
      default:
        return formatPillHotkeyLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();
  const assistantVoiceState =
    isRecording && isAssistantVoice
      ? "listening"
      : isProcessing && isAssistantVoice
        ? "transcribing"
        : "idle";
  const anyPanelOpen = assistant.open || liveTranscript.open;
  const anyPanelMounted = assistant.mounted || liveTranscript.mounted;
  const canReopenLiveTranscript =
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: liveTranscript.manuallyCollapsed,
      isRecording,
      isProcessing,
      isAssistantVoice,
    }) && !anyPanelMounted;
  const agentModeActive = resolveAgentModeActive({
    isAssistantVoice,
    isRecording,
    isProcessing: isVisuallyProcessing,
    assistantPanelMounted: assistant.mounted,
  });
  const assistantFooter = resolveAssistantFooterPresentation(assistant.footerPhase);
  const voicePillInteraction = resolveVoicePillInteraction({
    assistantMounted: assistant.mounted,
    liveTranscriptMounted: liveTranscript.mounted,
    isRecording,
    isProcessing,
    isHovered,
  });
  const pillIsInteractive = voicePillInteraction.pillInteractive;
  const activateVoicePill = () => {
    if (!pillIsInteractive) return;
    if (canReopenLiveTranscript) {
      liveTranscript.reopen();
      return;
    }
    if (
      shouldActivateVoicePill({
        hasDragged,
        liveTranscriptMounted: liveTranscript.mounted,
        isProcessing: micState === "processing",
        isAgentThinking: voiceActivity.isAgentThinking,
      })
    ) {
      setIsCommandMenuOpen(false);
      toggleListening({ voiceAgentRequested: assistant.mounted });
    }
  };
  // Prefer a currently open mode over a sibling finishing its exit. The core
  // itself never unmounts; only these inner sections change ownership.
  const activeVoicePanel = resolveVoicePanelCorePresentation({
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
  });
  const activeVoicePanelMode = activeVoicePanel.mode;
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscript.entrancePhase
  );
  const activeVoicePanelLabel =
    activeVoicePanelMode === "assistant"
      ? t("settingsPage.agentConfig.title")
      : activeVoicePanelMode === "live-transcript"
        ? t("transcriptionPreview.label")
        : undefined;
  const commonPillState =
    micState === "unavailable"
      ? "unavailable"
      : listeningEntrance.activeState ||
        voiceActivity.activeState ||
        (assistant.open ? (isHovered ? "hover" : "idle") : micState);
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptEntrancePhase: liveTranscript.entrancePhase,
    assistantOpen: assistant.open,
    panelStartPosition,
    horizontalDirection: voiceHorizontalDirection,
  });
  const voicePillTravelDuration =
    liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;
  const dictationErrorSuppressesPill =
    dictationErrorActionCount > 0 || dictationErrorPillHandoffActive;
  // Keep one pill DOM node alive while final Agent actions own the footer. On
  // close it can fade and travel from the panel dock instead of mounting at
  // the resting dock halfway through the surface contraction.
  const assistantActionsSuppressPill = assistant.open && !assistantFooter.pillVisible;
  const pillVisuallySuppressed = dictationErrorSuppressesPill || assistantActionsSuppressPill;
  const pillInteractionSuppressed = pillVisuallySuppressed || assistant.closing;

  // Where the hover-mounted chip lives depends on the row's anchor, so the
  // mic never shifts out from under an aimed click: bottom-right grows
  // leftward from its pinned right edge (chip before the mic is safe);
  // bottom-left grows rightward, so the chip goes after the mic; center
  // would shift the mic on any insertion, so the chip's space stays
  // reserved and only its visibility toggles.
  const isChipVisible =
    (isHovered || isLanguageMenuOpen) && !isVisuallyProcessing && !anyPanelMounted;
  const chipAfterMic = panelStartPosition === "bottom-left";
  const reserveChipSpace = panelStartPosition === "center";
  const languageChip = showLanguageSwitcher && (isChipVisible || reserveChipSpace) && (
    <div ref={languageMenuRef} className={`flex items-center${isChipVisible ? "" : " invisible"}`}>
      <PillTooltip content={activeLanguageLabel} disabled={isLanguageMenuOpen}>
        <button
          aria-label={t("app.mic.languageTooltip", {
            language: activeLanguageLabel,
          })}
          aria-haspopup="menu"
          aria-expanded={isLanguageMenuOpen}
          onClick={(e) => {
            e.stopPropagation();
            setIsCommandMenuOpen(false);
            setIsLanguageMenuOpen((prev) => !prev);
          }}
          className="h-[18px] px-1.5 rounded-full bg-surface-2/90 hover:bg-surface-2 border border-border hover:border-border-hover flex items-center gap-1 text-[10px] font-medium text-foreground shadow-sm backdrop-blur-sm transition-colors duration-150"
        >
          <span className="uppercase">{preferredLanguage}</span>
          <ChevronDown
            size={10}
            strokeWidth={2.5}
            className={`shrink-0 transition-transform duration-150 ${
              isLanguageMenuOpen ? "rotate-180" : ""
            }`}
          />
        </button>
      </PillTooltip>
      {isLanguageMenuOpen && (
        <div
          ref={languagePopupRef}
          className={`absolute bottom-full ${
            panelStartPosition === "bottom-left"
              ? "left-0"
              : panelStartPosition === "center"
                ? "left-1/2 -translate-x-1/2"
                : "right-0"
          } mb-2 w-44 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm`}
          role="menu"
        >
          {languageOptions.map((code) => {
            const isActive = code === preferredLanguage;
            return (
              <button
                key={code}
                className={`w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 first:pt-2 last:pb-2 hover:bg-muted focus:bg-muted focus:outline-none ${
                  isActive ? "text-primary font-medium" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  handlePanelLanguageSelect(code);
                  setIsLanguageMenuOpen(false);
                }}
                role="menuitemradio"
                aria-checked={isActive}
              >
                <span className="truncate flex-1">{getLanguageLabel(code)}</span>
                {isActive && <Check size={12} strokeWidth={2.5} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="dictation-window">
      {/* The panel footer can hide this pill, but never unmounts it. */}
      <div
        className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50 transition-opacity duration-150 ease-out ${
          pillInteractionSuppressed ? "pointer-events-none" : ""
        } ${pillVisuallySuppressed ? "opacity-0" : "opacity-100"}`}
        style={{
          "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
        }}
        data-dictation-error-suppressed={dictationErrorSuppressesPill || undefined}
        data-assistant-actions-suppressed={assistantActionsSuppressPill || undefined}
        aria-hidden={pillVisuallySuppressed || undefined}
      >
        <div
          className="assistant-pill-presence relative flex items-center gap-2"
          data-assistant-footer-phase={assistant.open ? assistant.footerPhase : undefined}
          data-horizontal-direction={voiceHorizontalDirection}
          style={{
            "--assistant-pill-retreat-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillRetreatMs}ms`,
            "--assistant-pill-entrance-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillEntranceMs}ms`,
          }}
          onMouseEnter={() => {
            if (!pillIsInteractive) return;
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!pillIsInteractive) return;
            if (!isCommandMenuOpen && !assistant.mounted) {
              setWindowInteractivity(false);
            }
          }}
        >
          {!chipAfterMic && languageChip}
          <PillTooltip
            content={canReopenLiveTranscript ? t("transcriptionPreview.label") : micTooltip}
            disabled={anyPanelMounted}
            align={panelStartPosition === "center" ? "center" : voiceHorizontalDirection}
          >
            <VoicePill
              ref={buttonRef}
              variant={anyPanelOpen ? "panel" : "floating"}
              state={commonPillState}
              expanded={!anyPanelOpen && isCompactPill}
              collapseToLogo={
                listeningEntrance.collapseToLogo || assistantFooter.collapsePillToLogo
              }
              beamActive={listeningEntrance.beamActive ?? undefined}
              waveformVisible={listeningEntrance.waveformVisible}
              waveformOnlyWhileRecording={anyPanelMounted}
              integratedWithPanel={liveTranscript.open}
              agentMode={agentModeActive}
              beamTheme={beamTheme}
              showExpandChevron={canReopenLiveTranscript && isHovered}
              getAudioLevel={getAudioLevel}
              isDragging={isDragging}
              horizontalDirection={voiceHorizontalDirection}
              role={pillIsInteractive ? "button" : "status"}
              tabIndex={pillIsInteractive ? 0 : undefined}
              aria-label={
                canReopenLiveTranscript
                  ? t("transcriptionPreview.label")
                  : assistant.mounted
                    ? t("settingsPage.agentConfig.title")
                    : liveTranscript.mounted
                      ? t("transcriptionPreview.label")
                      : micTooltip
              }
              onMouseDown={(e) => {
                if (anyPanelMounted) {
                  setHasDragged(false);
                  return;
                }
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (anyPanelMounted) return;
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                if (anyPanelMounted) return;
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                activateVoicePill();
                e.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.repeat || !isVoicePillActivationKey(event.key)) return;
                event.preventDefault();
                activateVoicePill();
              }}
              onContextMenu={(e) => {
                if (anyPanelMounted) return;
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
            />
          </PillTooltip>
          {voicePillInteraction.cancelVisible && (
            <button
              type="button"
              aria-label={
                isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (isRecording) cancelRecording();
                else cancelProcessing();
              }}
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/55 bg-surface-2 text-muted-foreground shadow-sm transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
          {chipAfterMic && languageChip}
          {!anyPanelMounted && isCommandMenuOpen && (
            <PillCommandMenu
              buttonRef={buttonRef}
              menuRef={commandMenuRef}
              languageMenuTriggerRef={languageMenuRef}
              showLanguageSwitcher={showLanguageSwitcher}
              languageOptions={languageOptions}
              preferredLanguage={preferredLanguage}
              onSelectLanguage={(code) => {
                handlePanelLanguageSelect(code);
                setIsCommandMenuOpen(false);
              }}
              isRecording={isRecording}
              agentAllowed={agentAllowed}
              isHovered={isHovered}
              setWindowInteractivity={setWindowInteractivity}
              onToggleListening={() => {
                toggleListening();
              }}
              onAskAssistant={() => {
                setIsCommandMenuOpen(false);
                assistant.openPanel();
              }}
              onHide={() => {
                setIsCommandMenuOpen(false);
                setWindowInteractivity(false);
                handleClose();
              }}
              onClose={() => setIsCommandMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <VoiceModePanelCore
        mode={activeVoicePanelMode}
        open={activeVoicePanel.open}
        closing={activeVoicePanelMode === "assistant" && assistant.closing}
        stage={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptEntrance.coreStage : "content"
        }
        horizontalDirection={voiceHorizontalDirection}
        label={activeVoicePanelLabel}
        measurementRevision={
          activeVoicePanelMode === "live-transcript" ? liveTranscript.measurementText : null
        }
        onPreferredHeightChange={liveTranscript.requestHeight}
        onClosingFadeComplete={assistant.completeContentFade}
      >
        {activeVoicePanelMode === "assistant" && assistant.mounted && (
          <AssistantPanel
            pendingCommand={assistant.pendingCommand}
            onCommandConsumed={assistant.handleCommandConsumed}
            onCommandDiscarded={assistant.handleCommandDiscarded}
            onCommandSettled={assistant.handleCommandSettled}
            initialConversationId={assistant.conversationId}
            onConversationIdChange={assistant.setConversationId}
            voiceState={assistantVoiceState}
            thinking={assistant.thinking && assistant.open}
            open={assistant.open}
            footerPhase={assistant.footerPhase}
            horizontalDirection={voiceHorizontalDirection}
            onClose={assistant.handleClose}
            onBusyChange={assistant.setBusy}
            onResponseReadyChange={assistant.setResponseReady}
            onResponseContent={assistant.handleResponseContent}
            onConversationReset={assistant.handleConversationReset}
            onSelectionContextChange={assistant.handleSelectionContextChange}
          />
        )}

        {activeVoicePanelMode !== "assistant" && (
          <LiveTranscriptPanel
            text={liveTranscript.mounted ? liveTranscript.text : ""}
            measurementText={liveTranscript.mounted ? liveTranscript.measurementText : ""}
            phase={liveTranscript.phase}
            processing={liveTranscript.mounted && isProcessing && !isAssistantVoice}
            controlsVisible={liveTranscript.mounted && liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscript.mounted && liveTranscriptEntrance.contentVisible}
            onCollapse={() => liveTranscript.close({ suppress: true })}
            onHoldChange={liveTranscript.holdFinal}
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
