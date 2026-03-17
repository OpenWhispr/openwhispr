import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

interface AgentTitleBarProps {
  onNewChat: () => void;
  onClose: () => void;
}

export function AgentTitleBar({ onNewChat, onClose }: AgentTitleBarProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "flex items-center justify-between h-8 px-3",
        "bg-surface-1 border-b border-border/30",
        "select-none"
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <span className="text-[11px] text-muted-foreground font-medium tracking-wide uppercase">
        {t("agentMode.titleBar.label")}
      </span>

      <div
        className="flex items-center gap-0.5"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          onClick={onNewChat}
          className={cn(
            "p-1 rounded-sm",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
          aria-label={t("agentMode.titleBar.newChat")}
        >
          <Plus size={14} />
        </button>
        <button
          onClick={onClose}
          className={cn(
            "p-1 rounded-sm",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
          aria-label={t("agentMode.titleBar.close")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
