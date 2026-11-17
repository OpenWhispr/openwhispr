import { useTranslation } from "react-i18next";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import { Check, FileText, Video } from "../icons";

const STARTER_PROMPTS = [
  { key: "chat.starters.todos", icon: Check },
  { key: "chat.starters.meeting", icon: Video },
  { key: "chat.starters.sharedNotes", icon: FileText },
] as const;

export function NewChatEmptyState({
  onPrompt,
  showSuggestions,
  disabled,
}: {
  onPrompt: (prompt: string) => void;
  showSuggestions: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full min-h-min grid-rows-[minmax(1rem,1fr)_auto_minmax(min-content,1fr)] justify-items-center px-4 pb-[var(--chat-composer-inset,5rem)] text-center">
      <BrandMarkIcon
        size={64}
        className="row-start-2 text-foreground/15 dark:text-muted-foreground/35"
      />
      {showSuggestions && (
        <div className="row-start-3 mt-8 grid self-start w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {STARTER_PROMPTS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onPrompt(t(key))}
              className="flex min-h-24 flex-col items-start justify-between rounded-2xl border border-border bg-card p-4 text-start text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon size={16} />
              </span>
              <span className="max-w-full truncate" title={t(key)}>
                {t(key)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
