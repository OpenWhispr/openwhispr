import { useTranslation } from "react-i18next";
import { GitFork, TextSelect, X } from "../icons";
import { cn } from "../lib/utils";
import type { AgentSelectionSource } from "../../utils/agentSelectionContext";

/** Selected text a request is (or was) about, quoted the way the request carries it. */
export function SelectedContextBlock({
  text,
  source,
  onRemove,
  className,
}: {
  text: string;
  source?: AgentSelectionSource;
  /** Offered before the request is sent. */
  onRemove?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("rounded-2xl bg-surface-1 px-3 py-2.5", className)}>
      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <TextSelect size={14} className="shrink-0" />
        <span className="flex-1">{t("agentWindow.selectedContext.title")}</span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t("agentWindow.selectedContext.remove")}
            title={t("agentWindow.selectedContext.remove")}
            className="flex size-5 items-center justify-center rounded-full transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <p dir="auto" className="mt-1.5 line-clamp-3 text-[15px] leading-snug text-foreground/85">
        {t(
          source === "external"
            ? "agentWindow.selectedContext.fromOtherApp"
            : "agentWindow.selectedContext.fromAnswer",
          { text }
        )}
      </p>
    </div>
  );
}

/** Where a fork came from; returns to that chat, which the fork left untouched. */
export function ForkOriginChip({ title, onOpen }: { title: string; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex h-[30px] max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-1 px-3 text-[13px] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
    >
      <GitFork size={14} className="shrink-0" />
      <span dir="auto" className="truncate">
        {t("chat.forkedFrom", { title })}
      </span>
    </button>
  );
}
