import { useMemo } from "react";
import { FileText, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import MemberAvatar from "../../MemberAvatar";
import { Button } from "../../ui/button";
import { EmptyState } from "../../ui/EmptyState";
import { groupItemsByDate } from "../../../utils/dateGrouping";
import { formatRelativeTime } from "../../../utils/dateFormatting";
import { useSpaceRoster } from "../../../hooks/useSpaceRoster";
import { useAuth } from "../../../hooks/useAuth";
import type { NoteItem, SpaceItem } from "../../../types/electron";

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
  const { user } = useAuth();
  const isTeamSpace = space.kind === "team";
  const roster = useSpaceRoster(isTeamSpace ? space.cloud_space_id : null);

  const groups = useMemo(() => groupItemsByDate(notes, (n) => n.updated_at, t), [notes, t]);

  if (notes.length === 0) {
    return (
      <EmptyState
        compact
        description={t("notes.overview.list.empty")}
        actions={
          <>
            <Button size="sm" onClick={onNewNote}>
              <Plus size={12} />
              {t("notes.empty.createNote")}
            </Button>
            {onAddExisting && (
              <Button variant="outline-flat" size="sm" onClick={onAddExisting}>
                {t("notes.addToFolder.addExisting")}
              </Button>
            )}
          </>
        }
        className="py-8"
      />
    );
  }

  return (
    <div className="pb-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="pt-4 pb-1 text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider select-none">
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
                className="w-full flex items-center gap-3 px-2 py-2 -mx-2 rounded-md text-left hover:bg-foreground/4 dark:hover:bg-white/4 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              >
                <FileText
                  size={14}
                  className="text-foreground/30 dark:text-foreground/20 shrink-0"
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
                    <span className="text-[11px] text-foreground/40 max-w-28 truncate">
                      {authorName}
                    </span>
                  </span>
                )}
                <span className="text-[11px] text-foreground/35 dark:text-foreground/25 shrink-0 tabular-nums">
                  {formatRelativeTime(note.updated_at, t)}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
