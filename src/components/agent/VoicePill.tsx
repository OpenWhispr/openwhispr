import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Maximize, Mic, MicOff, Minimize, Settings, X } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";
import { useAgentWindowDrag } from "./useAgentWindowDrag";
import { SoundBars } from "./SoundBars";
import { useSoundMeter } from "./useSoundMeter";

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

// While a turn works, the cap reads Working, then one, two and three dots and
// over again, so a long turn never reads as stuck. Each turn starts with none.
const WORKING_DOTS = 3;
const WORKING_DOT_MS = 900;

function useWorkingDots(active: boolean): number {
  const [dots, setDots] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(
      () => setDots((current) => (current + 1) % (WORKING_DOTS + 1)),
      WORKING_DOT_MS
    );
    return () => {
      clearInterval(timer);
      setDots(0);
    };
  }, [active]);
  return dots;
}

// The cap's outline: a tab whose shoulders run down into the pill below it.
const CAP_WIDTH = 196;
const CAP_HEIGHT = 28;
const CAP_PATH = "M0 28C13 28 14 1 39 1H157C182 1 183 28 196 28";

interface VoicePillProps {
  status: VoiceCallStatus;
  /** Said in the cap for a moment in place of the status (already translated). */
  notice?: string | null;
  /** The reply's or the microphone's level, for the Sound bars and the speaking glow. */
  readLevel: () => number;
  /** False dims the Sound bars: the call isn't running, or its microphone is off and nothing plays. */
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
  /** Stopped: in place of the controls, Back to typing. */
  onLeave: () => void;
  /** A card waits behind the pill: its cap brings it back. */
  onShowCard?: () => void;
  /**
   * A call started from the agent pill: this pill grows out of that one's width
   * and place (`drop` px below its own), its cap and controls rising in.
   */
  enterFrom?: { width: number; drop: number } | null;
}

/** A voice call's pill: its status above, then sound, Settings, Expand (or Minimize), Microphone and End. */
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
  enterFrom = null,
}: VoicePillProps) {
  const { t } = useTranslation();
  const dragHandlers = useAgentWindowDrag();
  const label = notice ?? t(STATUS_LABELS[status]);
  const working = status === "working" && !notice;
  const dots = useWorkingDots(working);
  const starting = status === "starting";
  const stopped = status === "stopped";
  const live = status === "listening" || status === "speaking";
  // A turn at work: a blue wave runs across the bars, as the shimmer does across "Thinking…".
  const busy = status === "working" || status === "sendingEmail" || status === "sendingMessage";
  const glow = !inModal && status === "speaking" && !notice;
  const pillRef = useRef<HTMLDivElement>(null);
  // The Sound bars and the glow follow the reply or the microphone as it is
  // heard (--voice-level) while the call listens or speaks.
  useSoundMeter(pillRef, live, readLevel);

  const surface = inModal ? "bg-surface-1 dark:bg-surface-2" : "agent-panel bg-surface-0";
  const capFill = inModal ? "fill-surface-1 dark:fill-surface-2" : "fill-[var(--color-surface-0)]";

  return (
    <div
      ref={pillRef}
      className="relative flex h-[65px] w-[237px] max-w-full shrink-0 flex-col items-center select-none"
      data-voice-pill
      data-call-enter={enterFrom ? "" : undefined}
      style={
        enterFrom
          ? ({
              "--call-enter-from": `${enterFrom.width}px`,
              "--call-enter-drop": `${enterFrom.drop}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <div
        data-voice-pill-cap
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
            {/* Every dot keeps its place, so Working never shifts as they come and go. */}
            {working && (
              <span aria-hidden="true">
                {Array.from({ length: WORKING_DOTS }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "transition-opacity duration-500 motion-reduce:transition-none",
                      index >= dots && "opacity-0"
                    )}
                  >
                    .
                  </span>
                ))}
              </span>
            )}
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
        data-voice-pill-body
        className={cn(
          "relative flex h-[38px] w-full cursor-grab items-center rounded-full border border-border ps-3.5 pe-1.5 text-muted-foreground shadow-[var(--shadow-card)] active:cursor-grabbing",
          surface
        )}
        {...dragHandlers}
      >
        <SoundBars shimmer={busy} dimmed={!waveformActive} />
        {stopped ? (
          <button
            type="button"
            onClick={onLeave}
            className="ms-auto flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-foreground transition-colors hover:bg-foreground/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            <Keyboard size={15} className="shrink-0" />
            <span className="truncate">{t("agentWindow.call.actions.backToText")}</span>
          </button>
        ) : (
          <div className="ms-auto flex items-center gap-0.5">
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
                inModal ? "agentWindow.actions.collapse" : "agentWindow.actions.expand"
              )}
              title={t(inModal ? "agentWindow.actions.collapse" : "agentWindow.actions.expand")}
              className={ICON_BUTTON}
            >
              {inModal ? <Minimize size={15} /> : <Maximize size={15} />}
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
              {micMuted ? <MicOff size={15} /> : <Mic size={15} />}
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
        )}
      </div>
    </div>
  );
}
