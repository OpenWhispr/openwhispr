import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { SourceNote } from "./useSourceNote";

/** Above a chat started from a note: which note, and the way back to it. */
export function SourceNoteBar({
  note,
  onOpen,
}: {
  note: SourceNote;
  onOpen: (note: SourceNote) => void;
}): ReactElement {
  const { t } = useTranslation();
  const title = note.title || t("notes.list.untitledNote");

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-default/70 bg-surface-secondary ps-4 pe-3 dark:border-white/8">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded",
          note.deleted ? "bg-text-primary/5 text-secondary" : "bg-brand-solid/10 text-brand-solid"
        )}
      >
        <FileText size={12} />
      </span>
      <span className="shrink-0 text-xs text-secondary">{t("chat.sourceNote.from")}</span>
      <span
        dir="auto"
        className={cn(
          "min-w-0 truncate text-xs",
          note.deleted
            ? "text-secondary line-through"
            : cn("font-medium text-primary", !note.title && "italic")
        )}
      >
        {title}
      </span>
      {note.deleted ? (
        <span className="shrink-0 text-xs text-secondary">· {t("chat.sourceNote.deleted")}</span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpen(note)}
          className="ms-auto h-6.5 rounded-md px-2 text-xs"
        >
          {t("chat.sourceNote.open")}
        </Button>
      )}
    </div>
  );
}
