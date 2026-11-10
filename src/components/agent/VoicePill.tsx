import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Messages, Mic, MicOff, Settings, X } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";
import { useAgentWindowDrag } from "./useAgentWindowDrag";

/** What the call's status cap says, from what is actually happening. */
export type VoiceCallStatus =
  | "starting"
  | "listening"
  | "working"
  | "speaking"
  | "micOff"
  | "waiting"
  | "sendingEmail"
  | "sendingMessage"
  | "stopped";

/** The session slot: End the call, or (while it speaks) stop just the reply. */
type VoiceSessionControl = "end" | "stopReply";

const STATUS_LABELS: Record<VoiceCallStatus, string> = {
  starting: "agentWindow.call.status.starting",
  listening: "agentWindow.call.status.listening",
  working: "agentWindow.call.status.working",
  speaking: "agentWindow.call.status.speaking",
  micOff: "agentWindow.call.status.micOff",
  waiting: "agentWindow.call.status.waiting",
  sendingEmail: "agentWindow.call.status.sendingEmail",
  sendingMessage: "agentWindow.call.status.sendingMessage",
  stopped: "agentWindow.call.status.stopped",
};

// The cap's outline: a tab whose shoulders run down into the pill below it.
const CAP_WIDTH = 196;
const CAP_HEIGHT = 28;
const CAP_PATH = "M0 28C13 28 14 1 39 1H157C182 1 183 28 196 28";
// The Sound glyph's four bars at rest; they rise with the sound, by up to SOUND_GAIN.
const SOUND_BARS_PX = [8, 10, 12, 8];
const SOUND_GAIN = 0.6;

interface VoicePillProps {
  status: VoiceCallStatus;
  /** Said in the cap for a moment in place of the status (already translated). */
  notice?: string | null;
  /** The reply's or the microphone's level, for the Sound bars and the speaking glow. */
  readLevel: () => number;
  /** The Sound bars follow sound; dimmed and still while the microphone is off and nothing plays. */
  waveformActive: boolean;
  micMuted: boolean;
  sessionControl: VoiceSessionControl;
  settingsOpen: boolean;
  /**
   * Inside the transcript the pill is a shade apart from the panel it sits on;
   * the compact pill shows speech as a glow in its cap instead of the word.
   */
  inModal?: boolean;
  onSettings: () => void;
  onTranscript: () => void;
  onMic: () => void;
  onEnd: () => void;
  onStopReply: () => void;
  /** Stopped: the pill is inert, and a click on it goes back to typing. */
  onLeave: () => void;
  /** A card waits behind the pill: its cap brings it back. */
  onShowCard?: () => void;
}

/** A voice call's pill: its status above, then sound, Settings, Chat, Microphone and End. */
export function VoicePill({
  status,
  notice = null,
  readLevel,
  waveformActive,
  micMuted,
  sessionControl,
  settingsOpen,
  inModal = false,
  onSettings,
  onTranscript,
  onMic,
  onEnd,
  onStopReply,
  onLeave,
  onShowCard,
}: VoicePillProps) {
  const { t } = useTranslation();
  const dragHandlers = useAgentWindowDrag();
  const label = notice ?? t(STATUS_LABELS[status]);
  const starting = status === "starting";
  const stopped = status === "stopped";
  const glow = !inModal && status === "speaking" && !notice;
  const levelActive = glow || (waveformActive && !stopped);
  const pillRef = useRef<HTMLDivElement>(null);

  // The Sound bars and the glow follow the reply or the microphone as it is
  // heard (--voice-level); they hold still under reduced motion, and an
  // animation ending never changes the call.
  useEffect(() => {
    const element = pillRef.current;
    if (!element) return undefined;
    if (!levelActive || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      element.style.setProperty("--voice-level", "0");
      return undefined;
    }
    let frame = 0;
    let level = 0;
    const paint = () => {
      level = level * 0.8 + Math.min(1, readLevel() * 6) * 0.2;
      element.style.setProperty("--voice-level", level.toFixed(3));
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [levelActive, readLevel]);

  const surface = inModal ? "bg-surface-1 dark:bg-surface-2" : "agent-panel bg-surface-0";
  const capFill = inModal ? "fill-surface-1 dark:fill-surface-2" : "fill-[var(--color-surface-0)]";

  return (
    <div
      ref={pillRef}
      className="relative flex h-[65px] w-[237px] max-w-full shrink-0 flex-col items-center select-none"
      data-voice-pill
    >
      <div
        className="relative z-10 -mb-px flex shrink-0 items-center justify-center"
        style={{ width: CAP_WIDTH, height: CAP_HEIGHT }}
      >
        <svg
          width={CAP_WIDTH}
          height={CAP_HEIGHT}
          viewBox={`0 0 ${CAP_WIDTH} ${CAP_HEIGHT}`}
          className={cn("absolute inset-0 overflow-visible stroke-border", capFill)}
          aria-hidden="true"
        >
          <path d={CAP_PATH} />
        </svg>
        {glow && (
          <div
            className="voice-pill-glow pointer-events-none absolute inset-0"
            style={{ clipPath: `path("${CAP_PATH}Z")` }}
          />
        )}
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "relative max-w-[150px] truncate text-[13px] text-foreground/90",
            starting && "agent-shimmer-text",
            glow && "sr-only"
          )}
        >
          <span
            key={label}
            className={cn("voice-pill-swap", status === "speaking" && "voice-pill-swap-slow")}
          >
            {label}
          </span>
        </span>
        {onShowCard && (
          <button
            type="button"
            onClick={onShowCard}
            aria-label={t("agentWindow.call.actions.showCard")}
            title={t("agentWindow.call.actions.showCard")}
            className="absolute inset-x-6 inset-y-0 rounded-t-xl focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          />
        )}
      </div>
      <div
        className={cn(
          "relative flex h-[38px] w-full cursor-grab items-center rounded-full border border-border ps-3.5 pe-1.5 text-muted-foreground shadow-[var(--shadow-card)] active:cursor-grabbing",
          surface
        )}
        {...dragHandlers}
      >
        <div
          className={cn(
            "flex h-5 shrink-0 items-center gap-[3.5px] text-foreground",
            !waveformActive && "opacity-50"
          )}
          aria-hidden="true"
        >
          {SOUND_BARS_PX.map((height, index) => (
            <span
              key={index}
              className="w-0.5 rounded-full bg-current"
              style={{
                height: `calc(${height}px * (1 + var(--voice-level, 0) * ${SOUND_GAIN}))`,
              }}
            />
          ))}
        </div>
        {/* Stopped: the controls fade on the pill's own surface. */}
        <div
          className={cn("ms-auto flex items-center gap-0.5", stopped && "opacity-40")}
          aria-hidden={stopped || undefined}
          inert={stopped || undefined}
        >
          <button
            type="button"
            onClick={onSettings}
            disabled={starting}
            aria-label={t("agentWindow.call.actions.settings")}
            aria-pressed={settingsOpen}
            title={t("agentWindow.call.actions.settings")}
            className={cn(ICON_BUTTON, settingsOpen && "bg-foreground/10 text-foreground")}
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            onClick={onTranscript}
            disabled={starting}
            aria-label={t(
              inModal
                ? "agentWindow.call.actions.hideTranscript"
                : "agentWindow.call.actions.transcript"
            )}
            aria-pressed={inModal}
            title={t(
              inModal
                ? "agentWindow.call.actions.hideTranscript"
                : "agentWindow.call.actions.transcript"
            )}
            className={ICON_BUTTON}
          >
            <Messages size={15} />
          </button>
          <button
            type="button"
            onClick={onMic}
            disabled={starting}
            aria-label={t(
              micMuted ? "agentWindow.call.actions.micOn" : "agentWindow.call.actions.micOff"
            )}
            aria-pressed={micMuted}
            title={t(
              micMuted ? "agentWindow.call.actions.micOn" : "agentWindow.call.actions.micOff"
            )}
            className={ICON_BUTTON}
          >
            {micMuted || stopped ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          {sessionControl === "stopReply" ? (
            <button
              type="button"
              onClick={onStopReply}
              aria-label={t("agentWindow.call.actions.stopReply")}
              title={t("agentWindow.call.actions.stopReply")}
              className="voice-pill-swap voice-pill-swap-slow ms-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[filter] hover:brightness-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="size-2.5 rounded-[2px] bg-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnd}
              aria-label={t("agentWindow.call.actions.end")}
              title={t("agentWindow.call.actions.end")}
              className="voice-pill-swap ms-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive text-white transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X size={14} strokeWidth={2.5} />
            </button>
          )}
        </div>
        {stopped && (
          <button
            type="button"
            onClick={onLeave}
            aria-label={t("agentWindow.call.actions.backToText")}
            title={t("agentWindow.call.actions.backToText")}
            className="absolute inset-0 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          />
        )}
      </div>
    </div>
  );
}
