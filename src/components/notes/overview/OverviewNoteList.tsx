import { useMemo } from "react";
import { FileText, Plus } from "../../icons";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../../hooks/useUiLocale";
import MemberAvatar from "../../MemberAvatar";
import { groupItemsByDate } from "../../../utils/dateGrouping";
import { formatRelativeTime } from "../../../utils/dateFormatting";
import { useSpaceRoster } from "../../../hooks/useSpaceRoster";
import { useAuth } from "../../../hooks/useAuth";
import type { NoteItem, SpaceItem } from "../../../types/electron";
import ThemedEmptyIllustration from "../../ui/ThemedEmptyIllustration";
import notesEmptyLight from "../../../assets/empty-states/notes-empty-light.svg";
import notesEmptyDark from "../../../assets/empty-states/notes-empty-dark.svg";

interface OverviewNoteListProps {
  notes: NoteItem[];
  space: SpaceItem;
  onOpenNote: (noteId: number) => void;
  onNewNote: () => void;
  onAddExisting?: () => void;
}

export function OverviewNoteList({
  notes,
  space,
  onOpenNote,
  onNewNote,
  onAddExisting,
}: OverviewNoteListProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const { user } = useAuth();
  const isTeamSpace = space.kind === "team";
  const roster = useSpaceRoster(isTeamSpace ? space.cloud_space_id : null);

  const groups = useMemo(() => groupItemsByDate(notes, (n) => n.updated_at, t), [notes, t]);

  if (notes.length === 0) {
    return (
      <div className="flex min-h-80 flex-col items-center justify-center px-4 py-8 text-center">
        <ThemedEmptyIllustration
          light={notesEmptyLight}
          dark={notesEmptyDark}
          width={327}
          height={117}
        />
        <h2 className="mt-6 text-lg font-semibold text-foreground">{t("notes.empty.title")}</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {t("notes.empty.description")}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={onNewNote}
            className="flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus size={11} />
            {t("notes.empty.createNote")}
          </button>
          {onAddExisting && (
            <button
              onClick={onAddExisting}
              className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("notes.addToFolder.addExisting")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pt-4 pb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider select-none">
            {group.label}
          </div>
          {group.items.map((note) => {
            const authorId = isTeamSpace ? note.updated_by_user_id : null;
            const member = authorId ? roster?.get(authorId) : undefined;
            const isSelf = authorId != null && authorId === user?.id;
            const authorName = isSelf
              ? t("notes.overview.author.you")
              : (member?.name ?? member?.email ?? null);
            return (
              <button
                key={note.id}
                onClick={() => onOpenNote(note.id)}
                className="w-full flex items-center gap-3 px-2 py-2 -mx-2 rounded-md text-start hover:bg-foreground/4 dark:hover:bg-white/4 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              >
                <FileText
                  size={14}
                  className="text-foreground/45 dark:text-foreground/45 shrink-0"
                />
                <span className="text-[13px] text-foreground/85 truncate flex-1">
                  {note.title || t("notes.list.untitled")}
                </span>
                {authorName && (
                  <span className="flex items-center gap-1.5 shrink-0">
                    <MemberAvatar
                      name={member?.name ?? authorName}
                      email={member?.email ?? ""}
                      image={member?.image}
                      size="sm"
                    />
                    <span className="text-[11px] text-foreground/45 max-w-28 truncate">
                      {authorName}
                    </span>
                  </span>
                )}
                <span className="text-[11px] text-foreground/45 dark:text-foreground/45 shrink-0 tabular-nums">
                  {formatRelativeTime(note.updated_at, t, locale)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
