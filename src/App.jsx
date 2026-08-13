import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore } from "./stores/settingsStore";
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { VoicePill } from "./components/dictation/VoicePill";
import { AssistantPanel } from "./components/dictation/AssistantPanel";

import { SIZE_RANK, resolveMainWindowSizeKey } from "./helpers/windowSizeLadder";

const ASSISTANT_TRANSITION_MS = 420;

// Tooltip Component
const Tooltip = ({ children, content, emoji, align = "center" }) => {
  const [isVisible, setIsVisible] = useState(false);

  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";

  const arrowClass =
    align === "right" ? "right-3" : align === "left" ? "left-3" : "left-1/2 -translate-x-1/2";

  return (
    <div className="relative inline-block">
      <div onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
        {children}
      </div>
      {isVisible && (
        <div
          className={`absolute bottom-full ${alignClass} mb-2 px-1.5 py-1 text-[10px] text-popover-foreground bg-popover border border-border rounded-md z-10 shadow-lg transition-opacity duration-150 whitespace-nowrap`}
        >
          {emoji && <span className="mr-1">{emoji}</span>}
          {content}
          <div
            className={`absolute top-full ${arrowClass} w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-popover`}
          ></div>
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const commandMenuRef = useRef(null);
  const buttonRef = useRef(null);
  const { toast, dismiss, toastCount } = useToast();
  const { t } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const prevAutoHideRef = useRef(floatingIconAutoHide);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const showGpuFallbackToast = () => {
      toast({
        title: t("app.toasts.gpuFallback.title"),
        description: t("app.toasts.gpuFallback.description"),
        duration: 10000,
      });
    };
    const unsubscribeCudaFallback =
      window.electronAPI?.onCudaFallbackNotification?.(showGpuFallbackToast);
    const unsubscribeGpuFallback =
      window.electronAPI?.onGpuFallbackNotification?.(showGpuFallbackToast);

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `\u201c${w}\u201d`).join(", ");
        let toastId;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          variant: "success",
          duration: 6000,
          action: (
            <button
              onClick={async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) {
                    dismiss(toastId);
                  }
                } catch {
                  // silently fail — word stays in dictionary
                }
              }}
              className="text-[10px] font-medium px-2.5 py-1 rounded-sm whitespace-nowrap
                text-emerald-100/90 hover:text-white
                bg-emerald-500/15 hover:bg-emerald-500/25
                border border-emerald-400/20 hover:border-emerald-400/35
                transition-all duration-150"
            >
              {t("app.toasts.undo")}
            </button>
          ),
        });
      }
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeCudaFallback?.();
      unsubscribeGpuFallback?.();
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);

  // Assistant panel: voice commands stream into the current conversation.
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const [assistantPanelOpen, setAssistantPanelOpen] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(null);
  const [panelConversationId, setPanelConversationId] = useState(null);
  const assistantPanelOpenRef = useRef(assistantPanelOpen);
  const commandIdRef = useRef(0);

  useLayoutEffect(() => {
    assistantPanelOpenRef.current = assistantPanelOpen;
  }, [assistantPanelOpen]);

  const runAssistantViewTransition = React.useCallback((update) => {
    if (typeof document.startViewTransition !== "function") {
      update();
      return null;
    }

    document.documentElement.classList.add("assistant-view-transition");
    try {
      const transition = document.startViewTransition(() => {
        flushSync(update);
      });
      const clearTransitionClass = () => {
        document.documentElement.classList.remove("assistant-view-transition");
      };
      transition.finished.then(clearTransitionClass, clearTransitionClass);
      return transition;
    } catch {
      document.documentElement.classList.remove("assistant-view-transition");
      update();
      return null;
    }
  }, []);

  const openAssistantPanel = React.useCallback(async () => {
    if (assistantPanelOpenRef.current) return;
    // Grow the window before the panel mounts so its entrance never paints
    // clipped inside the smaller pill/capsule bounds.
    await window.electronAPI?.resizeMainWindow?.("ASSISTANT");
    runAssistantViewTransition(() => setAssistantPanelOpen(true));
  }, [runAssistantViewTransition]);

  const handleAssistantCommand = React.useCallback(
    (command) => {
      commandIdRef.current += 1;
      setPendingCommand({
        id: commandIdRef.current,
        text: command.text,
        attachment: command.attachment ?? null,
      });
      openAssistantPanel();
    },
    [openAssistantPanel]
  );

  const handleCommandConsumed = React.useCallback((id) => {
    setPendingCommand((current) => (current?.id === id ? null : current));
  }, []);

  useEffect(() => {
    window.electronAPI?.setAssistantPanelOpen?.(assistantPanelOpen);
    // The pill unmounts when the panel opens, so its mouseleave never fires;
    // clear the hover flag or window interactivity sticks on after close.
    if (assistantPanelOpen) setIsHovered(false);
  }, [assistantPanelOpen]);

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0 || assistantPanelOpen) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, assistantPanelOpen, setWindowInteractivity]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!assistantPanelOpenRef.current) {
      setWindowInteractivity(false);
    }
  }, [setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    isAssistantVoice,
    micCaptureStatus,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onAssistantCommand: handleAssistantCommand,
  });

  const handleAssistantPanelClose = React.useCallback(() => {
    // Dismissing the panel mid-command must also abandon the command, or its
    // completion reopens the panel and answers a question the user withdrew.
    if (isAssistantVoice) {
      if (isRecording) cancelRecording();
      else if (isProcessing) cancelProcessing();
    }
    runAssistantViewTransition(() => {
      setAssistantPanelOpen(false);
      setPendingCommand(null);
    });
  }, [
    isAssistantVoice,
    isRecording,
    isProcessing,
    cancelRecording,
    cancelProcessing,
    runAssistantViewTransition,
  ]);

  // Single owner of the window size: panel > menu > toast > capsule > base.
  // Grows apply immediately so content never clips; shrinks wait for the
  // content collapse animation to finish before the window snaps down.
  const isCapsule = isRecording || isProcessing;
  const lastSizeKeyRef = useRef(null);
  useEffect(() => {
    const target = resolveMainWindowSizeKey({
      panelOpen: assistantPanelOpen,
      menuOpen: isCommandMenuOpen,
      toastCount,
      capsule: isCapsule,
    });
    const prev = lastSizeKeyRef.current;
    lastSizeKeyRef.current = target;
    if (!prev || SIZE_RANK[target] >= SIZE_RANK[prev]) {
      window.electronAPI?.resizeMainWindow?.(target);
      return;
    }
    const shrinkDelay = prev === "ASSISTANT" ? ASSISTANT_TRANSITION_MS + 20 : 340;
    const timeout = setTimeout(() => window.electronAPI?.resizeMainWindow?.(target), shrinkDelay);
    return () => clearTimeout(timeout);
  }, [assistantPanelOpen, isCommandMenuOpen, toastCount, isCapsule]);

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
      !isProcessing &&
      toastCount === 0 &&
      !assistantPanelOpen
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
  }, [isRecording, isProcessing, floatingIconAutoHide, toastCount, assistantPanelOpen]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        setIsCommandMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // The assistant panel owns Escape while it is open.
        if (assistantPanelOpen) return;
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen, assistantPanelOpen]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (isHovered && !isRecording && !isProcessing) return "hover";
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
        return formatHotkeyListLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();

  if (assistantPanelOpen) {
    return (
      <div className="dictation-window">
        <AssistantPanel
          pendingCommand={pendingCommand}
          onCommandConsumed={handleCommandConsumed}
          initialConversationId={panelConversationId}
          onConversationIdChange={setPanelConversationId}
          voiceState={
            isRecording && isAssistantVoice
              ? "listening"
              : isProcessing && isAssistantVoice
                ? "transcribing"
                : "idle"
          }
          getAudioLevel={getAudioLevel}
          onClose={handleAssistantPanelClose}
        />
      </div>
    );
  }

  return (
    <div className="dictation-window">
      {/* Voice button - position determined by panelStartPosition setting */}
      <div
        className={`fixed bottom-1 z-50 ${
          panelStartPosition === "bottom-left"
            ? "left-1"
            : panelStartPosition === "center"
              ? "left-1/2 -translate-x-1/2"
              : "right-1"
        }`}
      >
        <div
          className="relative flex items-center gap-2"
          onMouseEnter={() => {
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!isCommandMenuOpen) {
              setWindowInteractivity(false);
            }
          }}
        >
          <Tooltip
            content={micTooltip}
            align={
              panelStartPosition === "bottom-left"
                ? "left"
                : panelStartPosition === "center"
                  ? "center"
                  : "right"
            }
          >
            <VoicePill
              ref={buttonRef}
              variant="floating"
              state={micState}
              expanded={isCapsule}
              getAudioLevel={getAudioLevel}
              isDragging={isDragging}
              cancelLabel={
                isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
              }
              onCancel={() => (isRecording ? cancelRecording() : cancelProcessing())}
              role="button"
              aria-label={micTooltip}
              onMouseDown={(e) => {
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
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
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                if (!hasDragged && micState !== "processing") {
                  setIsCommandMenuOpen(false);
                  toggleListening();
                }
                e.preventDefault();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
            />
          </Tooltip>
          {isCommandMenuOpen && (
            <div
              ref={commandMenuRef}
              className="absolute bottom-full right-0 mb-3 w-48 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm"
              onMouseEnter={() => {
                setWindowInteractivity(true);
              }}
              onMouseLeave={() => {
                if (!isHovered) {
                  setWindowInteractivity(false);
                }
              }}
            >
              <button
                className="w-full px-3 py-2 text-left text-sm font-medium hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => {
                  toggleListening();
                }}
              >
                {isRecording
                  ? t("app.commandMenu.stopListening")
                  : t("app.commandMenu.startListening")}
              </button>
              {agentAllowed && (
                <>
                  <div className="h-px bg-border" />
                  <button
                    className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                    onClick={() => {
                      setIsCommandMenuOpen(false);
                      openAssistantPanel();
                    }}
                  >
                    {t("app.commandMenu.askAssistant")}
                  </button>
                </>
              )}
              <div className="h-px bg-border" />
              <button
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                onClick={() => {
                  setIsCommandMenuOpen(false);
                  setWindowInteractivity(false);
                  handleClose();
                }}
              >
                {t("app.commandMenu.hideForNow")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
