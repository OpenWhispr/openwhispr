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
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 bg-surface-1/85 ps-4 pe-3 backdrop-blur-sm dark:border-white/8">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded",
          note.deleted ? "bg-foreground/5 text-muted-foreground" : "bg-primary/10 text-primary"
        )}
      >
        <FileText size={12} />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{t("chat.sourceNote.from")}</span>
      <span
        dir="auto"
        className={cn(
          "min-w-0 truncate text-xs",
          note.deleted
            ? "text-muted-foreground line-through"
            : cn("font-medium text-foreground", !note.title && "italic")
        )}
      >
        {title}
      </span>
      {note.deleted ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          · {t("chat.sourceNote.deleted")}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpen(note)}
          className="ms-auto h-[26px] rounded-md px-2 text-xs"
        >
          {t("chat.sourceNote.open")}
        </Button>
      )}
    </div>
  );
}
