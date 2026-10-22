import { useTranslation } from "react-i18next";
import { Keyboard, Maximize, Mic, Square, X, type IconComponent } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "../chat/interactions/cardStyles";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import { PillWaveform } from "../dictation/PillWaveform";
import type { AgentPillButton, AgentPillControls } from "./agentWindowState";

const BUTTONS: Record<AgentPillButton, { icon: IconComponent; label: string }> = {
  expand: { icon: Maximize, label: "agentWindow.actions.expand" },
  mic: { icon: Mic, label: "agentWindow.actions.speak" },
  keyboard: { icon: Keyboard, label: "agentWindow.actions.type" },
  stop: { icon: Square, label: "agentWindow.actions.stop" },
  close: { icon: X, label: "agentWindow.actions.close" },
};

interface AgentPillProps {
  controls: AgentPillControls;
  /** The waveform moves only while the take records. */
  recording: boolean;
  readLevel: () => number;
  /** Shown in place of the waveform (already translated). */
  notice?: string | null;
  /** Voice input is unavailable with this transcription provider: Mic is off. */
  micUnavailableHint?: string;
  /** A take is still transcribing, or a reply is running. */
  micDisabled?: boolean;
  /** A card waits on the user: Expand pulses blue until the modal opens to it. */
  expandCue?: boolean;
  /** Inside the modal the pill is a shade apart from the panel it sits on. */
  inModal?: boolean;
  onAction: (button: AgentPillButton) => void;
  className?: string;
}

/** The agent's pill: the logo and what it is doing, then its controls. */
export function AgentPill({
  controls,
  recording,
  readLevel,
  notice,
  micUnavailableHint,
  micDisabled = false,
  expandCue = false,
  inModal = false,
  onAction,
  className,
}: AgentPillProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-10 max-w-full items-center rounded-full border border-border ps-2.5 pe-1.25 text-muted-foreground shadow-[var(--shadow-card)]",
        inModal ? "bg-surface-1 dark:bg-surface-2" : "bg-surface-0",
        className
      )}
    >
      <BrandMarkIcon size={16} className="shrink-0 text-primary" />
      {notice ? (
        <span className="ms-2.5 max-w-30 truncate text-xs text-foreground/80" title={notice}>
          {notice}
        </span>
      ) : controls.waiting ? (
        // Truncates where a translation outgrows the window.
        <span
          className="ms-2.5 min-w-0 truncate text-sm text-foreground/80 select-none"
          title={t("agentWindow.waitingForAnswer")}
        >
          {t("agentWindow.waitingForAnswer")}
        </span>
      ) : controls.thinking ? (
        <span className="agent-shimmer-text ms-3.5 me-2 min-w-0 truncate text-sm select-none">
          {t("agentMode.input.thinking")}
        </span>
      ) : controls.waveform ? (
        <PillWaveform
          getLevel={readLevel}
          active={recording}
          bars={4}
          maxBarPx={14}
          className="ms-2 h-6 gap-1 text-foreground"
        />
      ) : null}
      {!controls.thinking && (
        <span className="mx-3 h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
      )}
      <div className="flex items-center gap-0.5">
        {controls.buttons.map((button) => {
          const { icon: Icon, label } = BUTTONS[button];
          const unavailable = button === "mic" ? micUnavailableHint : undefined;
          return (
            <button
              key={button}
              type="button"
              onClick={() => onAction(button)}
              disabled={button === "mic" && (micDisabled || Boolean(unavailable))}
              aria-label={t(label)}
              title={unavailable ?? t(label)}
              className={cn(ICON_BUTTON, button === "expand" && expandCue && "agent-expand-cue")}
            >
              <Icon size={button === "stop" ? 14 : 16} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
