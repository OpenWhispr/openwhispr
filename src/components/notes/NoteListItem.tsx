import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, FolderOpen, Trash2, Check, Plus, Search } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { NoteItem, FolderItem } from "../../types/electron";
import { normalizeDbDate } from "../../utils/dateFormatting";

const RE_HEADING = /#{1,6}\s+/g;
const RE_EMPHASIS = /[*_~`]+/g;
const RE_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const RE_IMAGE = /!\[([^\]]*)\]\([^)]+\)/g;
const RE_BLOCKQUOTE = />\s+/g;
const RE_NEWLINES = /\n+/g;

interface NoteListItemProps {
  note: NoteItem;
  isActive: boolean;
  onClick: () => void;
  onDelete: (id: number) => void;
  folders: FolderItem[];
  currentFolderId: number | null;
  onMoveToFolder: (noteId: number, folderId: number) => void;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  dragHandlers?: {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  isDragging?: boolean;
}

function stripMarkdown(text: string): string {
  return text
    .replace(RE_HEADING, "")
    .replace(RE_EMPHASIS, "")
    .replace(RE_LINK, "$1")
    .replace(RE_IMAGE, "$1")
    .replace(RE_BLOCKQUOTE, "")
    .replace(RE_NEWLINES, " ")
    .trim();
}

function relativeTime(
  dateStr: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;

  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("notes.list.timeNow");
  if (minutes < 60) return t("notes.list.minutesAgo", { count: minutes });
  if (hours < 24) return t("notes.list.hoursAgo", { count: hours });
  if (days < 7) return t("notes.list.daysAgo", { count: days });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function NoteListItem({
  note,
  isActive,
  onClick,
  onDelete,
  folders,
  currentFolderId,
  onMoveToFolder,
  onCreateFolderAndMove,
  dragHandlers,
  isDragging,
}: NoteListItemProps) {
  const { t } = useTranslation();
  const preview = stripMarkdown(note.content);
  const [folderSearch, setFolderSearch] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const filteredFolders = useMemo(
    () =>
      folderSearch
        ? folders.filter((f) => f.name.toLowerCase().includes(folderSearch.toLowerCase()))
        : folders,
    [folders, folderSearch]
  );

  return (
    <button
      type="button"
      onClick={onClick}
      {...dragHandlers}
      className={cn(
        "group relative w-full text-left px-3 py-2 cursor-pointer transition-all duration-150",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
        isActive ? "bg-primary/6 dark:bg-primary/8" : "hover:bg-foreground/3 dark:hover:bg-white/3",
        isDragging && "opacity-40 scale-[0.97]"
      )}
    >
      {isActive && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-r-full bg-primary" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              "text-xs truncate transition-colors duration-150 text-foreground",
              isActive && "font-medium"
            )}
          >
            {note.title || t("notes.list.untitled")}
          </p>
          <div className="flex items-center gap-0.5 shrink-0">
            <span className="text-xs text-muted-foreground dark:text-muted-foreground/30 tabular-nums group-hover:opacity-0 transition-opacity">
              {relativeTime(note.updated_at, t)}
            </span>
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) {
                  setFolderSearch("");
                  setIsCreating(false);
                  setNewFolderName("");
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={(e) => e.stopPropagation()}
                  className="h-5 w-5 rounded-sm opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity absolute right-2 text-muted-foreground/60 dark:text-muted-foreground/40 hover:text-foreground/60 hover:bg-foreground/5 active:bg-foreground/8"
                >
                  <MoreHorizontal size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="text-xs gap-2 rounded-lg px-2.5 py-1.5 cursor-pointer focus:bg-foreground/5 data-[state=open]:bg-foreground/5">
                    <FolderOpen
                      size={12}
                      className="text-muted-foreground/80 dark:text-muted-foreground/60"
                    />
                    {t("notes.context.moveToFolder")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    sideOffset={4}
                    className="min-w-36 rounded-xl border border-border p-1"
                  >
                    {folders.length > 5 && (
                      <>
                        <div className="relative px-2 py-1.5">
                          <Search
                            size={9}
                            className="absolute left-4 top-1/2 -translate-y-1/2 text-foreground/15 pointer-events-none"
                          />
                          <input
                            value={folderSearch}
                            onChange={(e) => setFolderSearch(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t("notes.context.searchFolders")}
                            style={{ background: "none" }}
                            className="w-full pl-5 pr-1 py-0.5 text-xs text-foreground placeholder:text-foreground/15 outline-none border-none appearance-none"
                          />
                        </div>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <div className="overflow-y-auto max-h-40">
                      {filteredFolders.map((folder) => {
                        const isCurrent = folder.id === currentFolderId;
                        return (
                          <DropdownMenuItem
                            key={folder.id}
                            disabled={isCurrent}
                            onClick={(e) => {
                              e.stopPropagation();
                              onMoveToFolder(note.id, folder.id);
                            }}
                            className="text-xs gap-2 rounded-md px-2 py-1"
                          >
                            <span className="truncate flex-1">{folder.name}</span>
                            {isCurrent && <Check size={9} className="text-primary shrink-0" />}
                          </DropdownMenuItem>
                        );
                      })}
                      {folderSearch && filteredFolders.length === 0 && (
                        <p className="text-xs text-foreground/20 text-center py-1.5">
                          {t("notes.context.noResults")}
                        </p>
                      )}
                    </div>
                    <DropdownMenuSeparator />
                    {isCreating ? (
                      <div className="px-2 py-1">
                        <input
                          autoFocus
                          value={newFolderName}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter" && newFolderName.trim()) {
                              onCreateFolderAndMove(note.id, newFolderName.trim());
                              setNewFolderName("");
                              setIsCreating(false);
                            }
                            if (e.key === "Escape") {
                              setIsCreating(false);
                              setNewFolderName("");
                            }
                          }}
                          placeholder={t("notes.folders.folderName")}
                          className="w-full bg-transparent text-xs text-foreground placeholder:text-foreground/15 outline-none border-none appearance-none"
                        />
                      </div>
                    ) : (
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault();
                          setIsCreating(true);
                        }}
                        className="text-xs gap-2 rounded-md px-2 py-1 text-foreground/40"
                      >
                        <Plus size={10} />
                        {t("notes.context.newFolder")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(note.id);
                  }}
                  className="text-xs gap-2 rounded-lg px-2.5 py-1.5 text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 size={12} />
                  {t("notes.context.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {preview && (
          <p className="text-xs text-muted-foreground/80 dark:text-muted-foreground/40 line-clamp-1 mt-0.5">
            {preview}
          </p>
        )}
      </div>
    </button>
  );
}
