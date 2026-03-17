import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyLabel, isGlobeLikeHotkey } from "../../utils/hotkeys";

type AgentState = "idle" | "listening" | "transcribing" | "thinking" | "streaming";

interface AgentInputProps {
  agentState: AgentState;
  partialTranscript: string;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center justify-center",
        "min-w-5 h-4.5 px-1.5",
        "text-[10px] font-medium leading-none",
        "text-muted-foreground/70",
        "bg-foreground/6 border border-foreground/8",
        "rounded-sm",
        "shadow-[0_1px_0_0_rgba(0,0,0,0.04)]"
      )}
    >
      {children}
    </kbd>
  );
}

function HotkeyKeys({ hotkey }: { hotkey: string }) {
  const label = formatHotkeyLabel(hotkey);

  if (isGlobeLikeHotkey(hotkey) || !label.includes("+")) {
    return <Kbd>{label}</Kbd>;
  }

  const parts = label.split("+");

  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <Kbd key={i}>{part}</Kbd>
      ))}
    </span>
  );
}

function WaveBars() {
  return (
    <div className="flex items-center justify-center gap-[3px] h-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="w-[3px] bg-primary rounded-full origin-center"
          style={{
            animation: `waveform-bar 0.8s ease-in-out ${i * 0.12}s infinite`,
            height: "16px",
          }}
        />
      ))}
    </div>
  );
}

function InputLoadingDots() {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60"
          style={{
            animation: `agent-loading-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

export function AgentInput({ agentState, partialTranscript }: AgentInputProps) {
  const { t } = useTranslation();
  const agentKey = useSettingsStore((s) => s.agentKey);

  return (
    <div
      className={cn(
        "flex items-center gap-3 h-12 px-3 py-2 shrink-0",
        "bg-surface-1 border-t border-border/30"
      )}
    >
      {agentState === "idle" && (
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <div
              className="text-muted-foreground/50"
              style={{ animation: "agent-mic-pulse 2.5s ease-in-out infinite" }}
            >
              <Mic size={14} />
            </div>
            <span className="text-[11px] text-muted-foreground/50 select-none">
              {t("agentMode.input.holdToSpeak")}
            </span>
            <HotkeyKeys hotkey={agentKey} />
          </div>
          <div className="flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span className="text-[10px] text-muted-foreground/35 select-none">
              {t("agentMode.input.toClose")}
            </span>
          </div>
        </div>
      )}

      {agentState === "listening" && (
        <>
          <WaveBars />
          <span className="text-[12px] text-foreground/80 truncate flex-1">
            {partialTranscript || t("agentMode.input.listening")}
          </span>
        </>
      )}

      {agentState === "transcribing" && (
        <>
          <InputLoadingDots />
          <span className="text-[12px] text-muted-foreground select-none">
            {t("agentMode.input.transcribing")}
          </span>
        </>
      )}

      {(agentState === "thinking" || agentState === "streaming") && (
        <>
          <InputLoadingDots />
          <span className="text-[12px] text-muted-foreground select-none">
            {t("agentMode.input.thinking")}
          </span>
        </>
      )}
    </div>
  );
}
