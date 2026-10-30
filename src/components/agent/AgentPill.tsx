import { useTranslation } from "react-i18next";
import { Keyboard, Maximize, Mic, Square, X, type IconComponent } from "../icons";
import { cn } from "../lib/utils";
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
  onAction,
  className,
}: AgentPillProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-1 rounded-full border border-border/60 bg-surface-1 ps-2 pe-1.5 text-muted-foreground shadow-[var(--shadow-card)]",
        className
      )}
    >
      <BrandMarkIcon size={22} className="shrink-0 text-primary" />
      {notice ? (
        <span className="max-w-30 truncate ps-1 text-xs text-foreground/80" title={notice}>
          {notice}
        </span>
      ) : controls.thinking ? (
        <span className="thinking-shimmer-text ps-1 text-[13px] font-medium select-none">
          {t("agentMode.input.thinking")}
        </span>
      ) : controls.waveform ? (
        <PillWaveform getLevel={readLevel} active={recording} className="h-6 text-foreground" />
      ) : null}
      <span className="mx-1 h-4 w-px shrink-0 bg-border/70" aria-hidden="true" />
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
            className="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <Icon size={button === "stop" ? 14 : 16} />
          </button>
        );
      })}
    </div>
  );
}
