import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { X, Mic, MicOff, EyeOff } from "lucide-react";
import { useToast } from "./components/ui/useToast";
import { LoadingDots } from "./components/ui/LoadingDots";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore } from "./stores/settingsStore";

// Sound Wave Icon — 5 thin bars at graduated heights
const SoundWaveIcon = ({ size = 16 }) => {
  const barHeights = [0.45, 0.75, 1.0, 0.75, 0.45];
  const barWidth = Math.max(1.5, size * 0.13);
  return (
    <div className="flex items-center justify-center gap-px">
      {barHeights.map((h, i) => (
        <div
          key={i}
          className="bg-white rounded-full"
          style={{ width: barWidth, height: size * h }}
        />
      ))}
    </div>
  );
};

// Voice Wave Indicator — staggered bounce animation using existing waveform-bar keyframe
const VoiceWaveIndicator = ({ isListening }) => {
  const bars = [0.45, 0.75, 1.0, 0.75, 0.45];
  const size = 16;
  const barWidth = Math.max(1.5, size * 0.13);
  return (
    <div className="flex items-center justify-center gap-px" style={{ height: size }}>
      {bars.map((h, i) => (
        <div
          key={i}
          className="bg-white rounded-full"
          style={{
            width: barWidth,
            height: size * h,
            transformOrigin: "center",
            animation: isListening
              ? `waveform-bar ${0.5 + i * 0.06}s ease-in-out ${i * 0.09}s infinite`
              : "none",
          }}
        />
      ))}
    </div>
  );
};

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

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `“${w}”`).join(", ");
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
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, setWindowInteractivity]);

  useEffect(() => {
    const resizeWindow = () => {
      if (isCommandMenuOpen && toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("EXPANDED");
      } else if (isCommandMenuOpen) {
        window.electronAPI?.resizeMainWindow?.("WITH_MENU");
      } else if (toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("WITH_TOAST");
      } else {
        window.electronAPI?.resizeMainWindow?.("BASE");
      }
    };
    resizeWindow();
  }, [isCommandMenuOpen, toastCount]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const { isRecording, isProcessing, toggleListening, cancelRecording, cancelProcessing } =
    useAudioRecording(toast, {
      onToggle: handleDictationToggle,
    });

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

    if (floatingIconAutoHide && !isRecording && !isProcessing && toastCount === 0) {
      // Delay briefly so processing can start after recording stops without a flash
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [isRecording, isProcessing, floatingIconAutoHide, toastCount]);

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
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (isHovered && !isRecording && !isProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicButtonProps = () => {
    const baseClasses =
      "rounded-full w-10 h-10 flex items-center justify-center relative overflow-hidden border border-white/25 cursor-pointer";

    switch (micState) {
      case "idle":
        return {
          className: `${baseClasses} bg-gradient-to-br from-zinc-800/75 to-black/85`,
          tooltip: formatHotkeyLabel(hotkey),
          style: {
            boxShadow: "0 2px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)",
          },
        };
      case "hover":
        return {
          className: `${baseClasses} bg-gradient-to-br from-zinc-600/85 to-zinc-900/90 scale-105`,
          tooltip: formatHotkeyLabel(hotkey),
          style: {
            boxShadow:
              "0 0 0 3px rgba(255,255,255,0.12), 0 4px 20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.12)",
          },
        };
      case "recording":
        return {
          className: `${baseClasses} bg-primary scale-110 border-white/10`,
          tooltip: t("app.mic.recording"),
          style: {
            boxShadow:
              "0 0 0 5px rgba(255,255,255,0.15), 0 0 28px rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.4)",
          },
        };
      case "processing":
        return {
          className: `${baseClasses} bg-accent scale-105 border-white/10 cursor-not-allowed`,
          tooltip: t("app.mic.processing"),
          style: {
            boxShadow: "0 0 0 3px rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.4)",
          },
        };
      default:
        return {
          className: `${baseClasses} bg-gradient-to-br from-zinc-800/75 to-black/85`,
          style: {
            transform: "scale(0.8)",
            boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
          },
          tooltip: t("app.mic.clickToSpeak"),
        };
    }
  };

  const micProps = getMicButtonProps();

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
          {(isRecording || isProcessing) && isHovered && (
            <button
              aria-label={
                isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
              }
              onClick={(e) => {
                e.stopPropagation();
                isRecording ? cancelRecording() : cancelProcessing();
              }}
              className="group/cancel w-5 h-5 rounded-full bg-surface-2/90 hover:bg-destructive border border-border hover:border-destructive/70 flex items-center justify-center transition-colors duration-150 shadow-sm backdrop-blur-sm"
            >
              <X
                size={10}
                strokeWidth={2.5}
                className="text-foreground group-hover/cancel:text-destructive-foreground transition-colors duration-150"
              />
            </button>
          )}
          <Tooltip
            content={micProps.tooltip}
            align={
              panelStartPosition === "bottom-left"
                ? "left"
                : panelStartPosition === "center"
                  ? "center"
                  : "right"
            }
          >
            <button
              ref={buttonRef}
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
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                if (!hasDragged) {
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
              onFocus={() => setIsHovered(true)}
              onBlur={() => setIsHovered(false)}
              className={micProps.className}
              style={{
                ...micProps.style,
                cursor:
                  micState === "processing"
                    ? "not-allowed"
                    : isDragging
                      ? "grabbing"
                      : "pointer",
                transition:
                  "transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.2s ease-out, box-shadow 0.2s ease-out",
              }}
            >
              {/* Shine overlay — brightens on hover */}
              <div
                className="absolute inset-0 bg-gradient-to-br from-white/12 to-transparent transition-opacity duration-200"
                style={{ opacity: micState === "hover" ? 1 : 0 }}
              />

              {/* Dynamic content based on state */}
              {micState === "idle" || micState === "hover" ? (
                <SoundWaveIcon size={micState === "idle" ? 13 : 15} />
              ) : micState === "recording" ? (
                <LoadingDots />
              ) : micState === "processing" ? (
                <VoiceWaveIndicator isListening={true} />
              ) : null}
            </button>
          </Tooltip>

          {/* Right-click command menu */}
          {isCommandMenuOpen && (
            <div
              ref={commandMenuRef}
              className="absolute bottom-full right-0 mb-3 w-52 rounded-xl border border-border/70 bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-md overflow-hidden"
              onMouseEnter={() => {
                setWindowInteractivity(true);
              }}
              onMouseLeave={() => {
                if (!isHovered) {
                  setWindowInteractivity(false);
                }
              }}
            >
              <div className="px-3 pt-2.5 pb-1">
                <p className="text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-widest">
                  OpenWhispr
                </p>
              </div>
              <div className="px-1.5 pb-1.5 flex flex-col gap-0.5">
                <button
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left text-sm rounded-lg hover:bg-muted focus:bg-muted focus:outline-none transition-colors duration-100"
                  onClick={() => {
                    toggleListening();
                  }}
                >
                  {isRecording ? (
                    <MicOff size={14} className="shrink-0 text-destructive" />
                  ) : (
                    <Mic size={14} className="shrink-0 text-primary" />
                  )}
                  <span className="font-medium">
                    {isRecording
                      ? t("app.commandMenu.stopListening")
                      : t("app.commandMenu.startListening")}
                  </span>
                </button>
                <button
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 text-left text-sm rounded-lg hover:bg-muted focus:bg-muted focus:outline-none transition-colors duration-100"
                  onClick={() => {
                    setIsCommandMenuOpen(false);
                    setWindowInteractivity(false);
                    handleClose();
                  }}
                >
                  <EyeOff size={14} className="shrink-0 text-muted-foreground" />
                  <span>{t("app.commandMenu.hideForNow")}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
