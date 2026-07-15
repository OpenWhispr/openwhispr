import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Share2,
  Smile,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useToast } from "../ui/useToast";
import {
  useNoteDragAndDrop,
  type DraggedNoteInfo,
  type NoteMoveTarget,
} from "../../hooks/useNoteDragAndDrop";
import { useTeamSpacesCapability } from "../../hooks/useTeamSpacesCapability";
import { useAuth } from "../../hooks/useAuth";
import { useWorkspace } from "../../hooks/useWorkspace";
import { canManageSpace } from "../../lib/spacePermissions";
import { TeamsService } from "../../services/TeamsService";
import { NoteSharingService } from "../../services/NoteSharingService";
import { markTeamSpacePurged } from "../../services/SyncService";
import { useSettingsStore } from "../../stores/settingsStore";
import { cn } from "../lib/utils";
import { formatRelativeTime } from "../../utils/dateFormatting";
import CreateSpaceDialog from "./CreateSpaceDialog";
import SpaceMembersDialog from "./SpaceMembersDialog";
import type { FolderItem, NoteItem, SpaceItem } from "../../types/electron";
import {
  folderContainerKey,
  spaceContainerKey,
  useSpaces,
  useFolders,
  useFolderCounts,
  useSpaceRootCounts,
  useNotesByContainer,
  useExpandedContainers,
  useActiveContext,
  useActiveNoteId,
  useIsTreeLoading,
  setActiveContext,
  setActiveNoteId,
  setContainerExpanded,
  toggleContainerExpanded,
  revealContainer,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolderToSpace,
  updateSpaceMeta,
  purgeSpace,
  getNoteFromStore,
  getFoldersValue,
  getSpacesValue,
  updateShareCache,
  persistNoteShareState,
} from "../../stores/noteStore";

const FOLDER_INPUT_CLASS =
  "w-full h-6 bg-foreground/5 dark:bg-white/5 rounded px-2 text-xs text-foreground outline-none border border-primary/30 focus:border-primary/50";

const ROW_BASE_CLASS =
  "group relative flex items-center gap-1.5 rounded-md cursor-pointer select-none " +
  "transition-colors duration-150 outline-none focus-visible:ring-1 focus-visible:ring-ring/30";

const KEBAB_BUTTON_CLASS =
  "h-5 w-5 rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 " +
  "transition-opacity text-muted-foreground/60 dark:text-muted-foreground/40 " +
  "hover:text-foreground/60 hover:bg-foreground/5 active:bg-foreground/8";

const KEBAB_TRIGGER_CLASS = cn(KEBAB_BUTTON_CLASS, "absolute right-1.5");

const MENU_ITEM_CLASS = "text-xs gap-2 rounded-md px-2 py-1";

const SUB_CONTENT_CLASS = "min-w-36 rounded-xl border border-border p-1";

type TFn = (key: string, options?: Record<string, unknown>) => string;

type TreeRow =
  | { type: "space"; key: string; space: SpaceItem; parentKey?: undefined }
  | { type: "folder"; key: string; folder: FolderItem; parentKey: string }
  | { type: "note"; key: string; note: NoteItem; parentKey: string; level: 2 | 3 };

interface DropHandlers {
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

interface RowA11yProps {
  tabIndex: number;
  rowRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}

interface SpacesTreeProps {
  onDeleteNote: (id: number) => void;
  onMoveNote: (noteId: number, target: NoteMoveTarget) => Promise<void>;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onNewNote: (spaceId: number, folderId: number | null) => void;
}

function spaceDisplayName(space: SpaceItem, t: TFn): string {
  return space.kind === "private" ? t("notes.spaces.personal") : space.name;
}

function useFileManagerName(): string {
  return navigator.platform.startsWith("Mac")
    ? "Finder"
    : navigator.platform.startsWith("Win")
      ? "Explorer"
      : "Files";
}

function SectionHeader({
  label,
  action,
  className,
}: {
  label: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="none" className={cn("flex items-center justify-between h-6 px-2 mt-1", className)}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50 select-none">
        {label}
      </span>
      {action}
    </div>
  );
}

function TreeChildren({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      role="none"
      className={cn(
        "grid transition-[grid-template-rows] duration-[160ms] ease-out",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
    >
      <div
        role="group"
        className={cn(
          "min-h-0 overflow-hidden transition-opacity duration-[80ms]",
          open ? "opacity-100" : "opacity-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}

function Chevron({ isExpanded, onToggle }: { isExpanded: boolean; onToggle: () => void }) {
  return (
    <span
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="h-4 w-4 flex items-center justify-center shrink-0 rounded-sm text-foreground/30 hover:text-foreground/60 transition-colors duration-150"
    >
      <ChevronRight
        size={12}
        className={cn("transition-transform duration-150", isExpanded && "rotate-90")}
      />
    </span>
  );
}

function SpaceMenuIcon({ space }: { space: SpaceItem }) {
  if (space.kind === "private") {
    return <Lock size={11} className="text-muted-foreground/60 shrink-0" />;
  }
  if (space.emoji) {
    return (
      <span className="text-[11px] leading-none shrink-0" aria-hidden="true">
        {space.emoji}
      </span>
    );
  }
  return <Users size={11} className="text-muted-foreground/60 shrink-0" />;
}

function SpaceRow({
  space,
  displayName,
  isExpanded,
  isActive,
  count,
  isDragOver,
  isDropSuccess,
  dropHandlers,
  canManage,
  canLeave,
  onActivate,
  onToggle,
  onNewFolder,
  onMembers,
  onRename,
  onLeave,
  onDelete,
  a11y,
  t,
}: {
  space: SpaceItem;
  displayName: string;
  isExpanded: boolean;
  isActive: boolean;
  count: number;
  isDragOver: boolean;
  isDropSuccess: boolean;
  dropHandlers: DropHandlers;
  canManage: boolean;
  canLeave: boolean;
  onActivate: () => void;
  onToggle: () => void;
  onNewFolder: () => void;
  onMembers: () => void;
  onRename: (focus: "name" | "emoji") => void;
  onLeave: () => void;
  onDelete: () => void;
  a11y: RowA11yProps;
  t: TFn;
}) {
  const isPrivate = space.kind === "private";
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={isExpanded}
      aria-selected={isActive}
      aria-label={
        count > 0 ? `${displayName}, ${t("notes.spaces.noteCount", { count })}` : displayName
      }
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onActivate}
      title={displayName}
      {...dropHandlers}
      className={cn(
        ROW_BASE_CLASS,
        "h-[30px] px-2",
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4",
        isDragOver && "bg-primary/12 dark:bg-primary/15 ring-1 ring-primary/25",
        isDropSuccess && "bg-emerald-500/10 dark:bg-emerald-400/10 ring-1 ring-emerald-500/20"
      )}
    >
      <Chevron isExpanded={isExpanded} onToggle={onToggle} />
      {isPrivate ? (
        <span title={t("notes.spaces.privateTooltip")} className="flex shrink-0">
          <Lock
            size={14}
            role="img"
            aria-label={t("notes.spaces.privateTooltip")}
            className={cn(
              "transition-colors duration-150",
              isActive ? "text-primary" : "text-foreground/35 dark:text-foreground/20"
            )}
          />
        </span>
      ) : space.emoji ? (
        <span className="text-[13px] leading-none shrink-0" aria-hidden="true">
          {space.emoji}
        </span>
      ) : (
        <Users
          size={14}
          className={cn(
            "shrink-0 transition-colors duration-150",
            isDragOver || isActive ? "text-primary" : "text-foreground/35 dark:text-foreground/20"
          )}
        />
      )}
      <span
        className={cn(
          "text-xs truncate flex-1 transition-colors duration-150",
          isDragOver || isActive ? "text-foreground font-medium" : "text-foreground/70"
        )}
      >
        {displayName}
      </span>
      {isDropSuccess ? (
        <Check
          size={10}
          className="text-emerald-500 dark:text-emerald-400 shrink-0 animate-[scale-in_200ms_ease-out]"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "text-xs tabular-nums shrink-0 transition-opacity group-hover:opacity-0",
            isActive
              ? "text-foreground/50 dark:text-foreground/30"
              : "text-foreground/35 dark:text-foreground/15"
          )}
        >
          {count > 0 ? count : ""}
        </span>
      )}
      <span className="absolute right-1.5 flex items-center gap-px">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("notes.context.newFolder")}
          onClick={(e) => {
            e.stopPropagation();
            onNewFolder();
          }}
          className={KEBAB_BUTTON_CLASS}
        >
          <Plus size={12} />
        </Button>
        {!isPrivate && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("common.actions")}
                onClick={(e) => e.stopPropagation()}
                className={KEBAB_BUTTON_CLASS}
              >
                <MoreHorizontal size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
              {space.cloud_team_id && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onMembers();
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <Users size={11} className="text-muted-foreground/60" />
                  {t("notes.spaces.members.menu")}
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename("name");
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    <Pencil size={11} className="text-muted-foreground/60" />
                    {t("notes.spaces.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename("emoji");
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    <Smile size={11} className="text-muted-foreground/60" />
                    {t("notes.spaces.changeEmoji")}
                  </DropdownMenuItem>
                </>
              )}
              {space.cloud_team_id && canLeave && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onLeave();
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <LogOut size={11} className="text-muted-foreground/60" />
                  {t("notes.spaces.members.leave")}
                </DropdownMenuItem>
              )}
              {canManage && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                    className={cn(
                      MENU_ITEM_CLASS,
                      "text-destructive focus:text-destructive focus:bg-destructive/10"
                    )}
                  >
                    <Trash2 size={11} />
                    {t("notes.spaces.deleteSpace")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </div>
  );
}

function FolderRow({
  folder,
  spaces,
  isExpanded,
  isActive,
  count,
  isDragOver,
  isDropSuccess,
  dropHandlers,
  noteFilesEnabled,
  fileManagerName,
  onActivate,
  onToggle,
  onRename,
  onMoveToSpace,
  onDelete,
  a11y,
  t,
}: {
  folder: FolderItem;
  spaces: SpaceItem[];
  isExpanded: boolean;
  isActive: boolean;
  count: number;
  isDragOver: boolean;
  isDropSuccess: boolean;
  dropHandlers: DropHandlers;
  noteFilesEnabled: boolean;
  fileManagerName: string;
  onActivate: () => void;
  onToggle: () => void;
  onRename: () => void;
  onMoveToSpace: (space: SpaceItem) => void;
  onDelete: () => void;
  a11y: RowA11yProps;
  t: TFn;
}) {
  const [spaceSearch, setSpaceSearch] = useState("");
  const canMoveToSpace = !folder.is_default && spaces.length > 1;
  const filteredSpaces = useMemo(
    () =>
      spaceSearch
        ? spaces.filter((s) =>
            spaceDisplayName(s, t).toLowerCase().includes(spaceSearch.toLowerCase())
          )
        : spaces,
    [spaces, spaceSearch, t]
  );

  return (
    <div
      role="treeitem"
      aria-level={2}
      aria-expanded={isExpanded}
      aria-selected={isActive}
      aria-label={
        count > 0 ? `${folder.name}, ${t("notes.spaces.noteCount", { count })}` : folder.name
      }
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onActivate}
      title={folder.name}
      {...dropHandlers}
      className={cn(
        ROW_BASE_CLASS,
        "h-7 pl-[14px] pr-2",
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4",
        isDragOver && "bg-primary/12 dark:bg-primary/15 ring-1 ring-primary/25",
        isDropSuccess && "bg-emerald-500/10 dark:bg-emerald-400/10 ring-1 ring-emerald-500/20"
      )}
    >
      <Chevron isExpanded={isExpanded} onToggle={onToggle} />
      <Folder
        size={14}
        className={cn(
          "shrink-0 transition-colors duration-150",
          isDragOver || isActive
            ? "text-primary"
            : "text-foreground/35 dark:text-foreground/20 group-hover:text-foreground/50 dark:group-hover:text-foreground/35"
        )}
      />
      <span
        className={cn(
          "text-xs truncate flex-1 transition-colors duration-150",
          isDragOver || isActive
            ? "text-foreground font-medium"
            : "text-foreground/50 group-hover:text-foreground/70"
        )}
      >
        {folder.name}
      </span>
      {isDropSuccess ? (
        <Check
          size={10}
          className="text-emerald-500 dark:text-emerald-400 shrink-0 animate-[scale-in_200ms_ease-out]"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "text-xs tabular-nums shrink-0 transition-opacity group-hover:opacity-0",
            isActive
              ? "text-foreground/50 dark:text-foreground/30"
              : "text-foreground/35 dark:text-foreground/15"
          )}
        >
          {count > 0 ? count : ""}
        </span>
      )}
      {(!folder.is_default || noteFilesEnabled) && (
        <DropdownMenu onOpenChange={(open) => !open && setSpaceSearch("")}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("common.actions")}
              onClick={(e) => e.stopPropagation()}
              className={KEBAB_TRIGGER_CLASS}
            >
              <MoreHorizontal size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-32">
            {noteFilesEnabled && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.showFolderInExplorer?.(folder.name);
                }}
                className={MENU_ITEM_CLASS}
              >
                <ExternalLink size={11} className="text-muted-foreground/60" />
                {t("notes.context.showInFileManager", { manager: fileManagerName })}
              </DropdownMenuItem>
            )}
            {!folder.is_default && (
              <>
                {noteFilesEnabled && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename();
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <Pencil size={11} className="text-muted-foreground/60" />
                  {t("notes.context.rename")}
                </DropdownMenuItem>
                {canMoveToSpace && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      className={cn(
                        MENU_ITEM_CLASS,
                        "cursor-pointer focus:bg-foreground/5 data-[state=open]:bg-foreground/5"
                      )}
                    >
                      <Users size={11} className="text-muted-foreground/60" />
                      {t("notes.spaces.moveToSpace")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent sideOffset={4} className={SUB_CONTENT_CLASS}>
                      {spaces.length > 5 && (
                        <>
                          <div className="relative px-1.5 py-0.5">
                            <Search
                              size={9}
                              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/15 pointer-events-none"
                            />
                            <input
                              value={spaceSearch}
                              onChange={(e) => setSpaceSearch(e.target.value)}
                              onKeyDown={(e) => e.stopPropagation()}
                              placeholder={t("notes.spaces.searchSpaces")}
                              className="input-inline w-full pl-4.5 pr-1 py-0.5 text-xs text-foreground placeholder:text-foreground/15 outline-none border-none appearance-none"
                            />
                          </div>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <div className="overflow-y-auto max-h-40">
                        {filteredSpaces.map((space) => {
                          const isCurrent = space.id === folder.space_id;
                          return (
                            <DropdownMenuItem
                              key={space.id}
                              disabled={isCurrent}
                              onClick={(e) => {
                                e.stopPropagation();
                                onMoveToSpace(space);
                              }}
                              className={MENU_ITEM_CLASS}
                            >
                              <SpaceMenuIcon space={space} />
                              <span className="truncate flex-1">{spaceDisplayName(space, t)}</span>
                              {isCurrent && <Check size={9} className="text-primary shrink-0" />}
                            </DropdownMenuItem>
                          );
                        })}
                        {spaceSearch && filteredSpaces.length === 0 && (
                          <p className="text-xs text-foreground/20 text-center py-1.5">
                            {t("notes.spaces.noSpacesFound")}
                          </p>
                        )}
                      </div>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  className={cn(
                    MENU_ITEM_CLASS,
                    "text-destructive focus:text-destructive focus:bg-destructive/10"
                  )}
                >
                  <Trash2 size={11} />
                  {t("notes.context.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

interface MoveOption {
  key: string;
  label: string;
  space: SpaceItem;
  target: NoteMoveTarget;
  isCurrent: boolean;
}

function NoteLeaf({
  note,
  level,
  isActive,
  isDragging,
  dragHandlers,
  spaces,
  folders,
  noteFilesEnabled,
  fileManagerName,
  onOpen,
  onMove,
  onCreateFolderAndMove,
  onDelete,
  a11y,
  t,
}: {
  note: NoteItem;
  level: 2 | 3;
  isActive: boolean;
  isDragging: boolean;
  dragHandlers: {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  spaces: SpaceItem[];
  folders: FolderItem[];
  noteFilesEnabled: boolean;
  fileManagerName: string;
  onOpen: () => void;
  onMove: (target: NoteMoveTarget) => void;
  onCreateFolderAndMove: (noteId: number, folderName: string) => void;
  onDelete: (id: number) => void;
  a11y: RowA11yProps;
  t: TFn;
}) {
  const [moveSearch, setMoveSearch] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const multiSpace = spaces.length > 1;

  const moveOptions = useMemo<MoveOption[]>(() => {
    const options: MoveOption[] = [];
    for (const space of spaces) {
      if (space.kind === "team") {
        options.push({
          key: spaceContainerKey(space.id),
          label: spaceDisplayName(space, t),
          space,
          target: { spaceId: space.id, folderId: null },
          isCurrent: note.folder_id == null && note.space_id === space.id,
        });
      }
      for (const folder of folders.filter((f) => f.space_id === space.id)) {
        options.push({
          key: folderContainerKey(folder.id),
          label: folder.name,
          space,
          target: { spaceId: space.id, folderId: folder.id },
          isCurrent: note.folder_id === folder.id,
        });
      }
    }
    return options;
  }, [spaces, folders, note.folder_id, note.space_id, t]);

  const filteredOptions = useMemo(() => {
    if (!moveSearch) return moveOptions;
    const query = moveSearch.toLowerCase();
    return moveOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        spaceDisplayName(option.space, t).toLowerCase().includes(query)
    );
  }, [moveOptions, moveSearch, t]);

  const renderOption = (option: MoveOption, label: string) => (
    <DropdownMenuItem
      key={option.key}
      disabled={option.isCurrent}
      onClick={(e) => {
        e.stopPropagation();
        onMove(option.target);
      }}
      className={MENU_ITEM_CLASS}
    >
      <span className="truncate flex-1">{label}</span>
      {option.isCurrent && <Check size={9} className="text-primary shrink-0" />}
    </DropdownMenuItem>
  );

  const title = note.title || t("notes.list.untitled");

  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={isActive}
      tabIndex={a11y.tabIndex}
      ref={a11y.rowRef}
      onKeyDown={a11y.onKeyDown}
      onFocus={a11y.onFocus}
      onClick={onOpen}
      title={title}
      {...dragHandlers}
      className={cn(
        ROW_BASE_CLASS,
        "h-7 pr-2",
        level === 3 ? "pl-7" : "pl-[14px]",
        isActive
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4",
        isDragging && "opacity-40"
      )}
    >
      <FileText
        size={13}
        className={cn(
          "shrink-0 transition-colors duration-150",
          isActive
            ? "text-primary"
            : "text-foreground/30 dark:text-foreground/20 group-hover:text-foreground/45 dark:group-hover:text-foreground/30"
        )}
      />
      <span
        className={cn(
          "text-xs truncate flex-1 transition-colors duration-150",
          isActive
            ? "text-foreground font-medium"
            : "text-foreground/60 group-hover:text-foreground/80"
        )}
      >
        {title}
      </span>
      {Boolean(note.is_shared) && (
        <Share2
          size={11}
          role="img"
          aria-label={t("notes.list.shared")}
          className="text-foreground/40 shrink-0 transition-opacity group-hover:opacity-0"
        />
      )}
      <span
        aria-hidden="true"
        className="text-[10px] tabular-nums shrink-0 text-foreground/35 dark:text-foreground/15 transition-opacity group-hover:opacity-0"
      >
        {formatRelativeTime(note.updated_at, t)}
      </span>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) {
            setMoveSearch("");
            setIsCreating(false);
            setNewFolderName("");
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.actions")}
            onClick={(e) => e.stopPropagation()}
            className={KEBAB_TRIGGER_CLASS}
          >
            <MoreHorizontal size={12} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
          {noteFilesEnabled && (
            <>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.showNoteFile?.(note.id);
                }}
                className={MENU_ITEM_CLASS}
              >
                <ExternalLink size={11} className="text-muted-foreground/60" />
                {t("notes.context.showInFileManager", { manager: fileManagerName })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className={cn(
                MENU_ITEM_CLASS,
                "cursor-pointer focus:bg-foreground/5 data-[state=open]:bg-foreground/5"
              )}
            >
              <FolderOpen size={11} className="text-muted-foreground/60" />
              {multiSpace ? t("notes.spaces.moveTo") : t("notes.context.moveToFolder")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent sideOffset={4} className={SUB_CONTENT_CLASS}>
              {moveOptions.length > 5 && (
                <>
                  <div className="relative px-1.5 py-0.5">
                    <Search
                      size={9}
                      className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/15 pointer-events-none"
                    />
                    <input
                      value={moveSearch}
                      onChange={(e) => setMoveSearch(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder={t("notes.context.searchFolders")}
                      className="input-inline w-full pl-4.5 pr-1 py-0.5 text-xs text-foreground placeholder:text-foreground/15 outline-none border-none appearance-none"
                    />
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}
              <div className="overflow-y-auto max-h-40">
                {moveSearch ? (
                  <>
                    {filteredOptions.map((option) =>
                      renderOption(
                        option,
                        multiSpace && option.target.folderId != null
                          ? `${spaceDisplayName(option.space, t)} / ${option.label}`
                          : option.label
                      )
                    )}
                    {filteredOptions.length === 0 && (
                      <p className="text-xs text-foreground/20 text-center py-1.5">
                        {t("notes.context.noResults")}
                      </p>
                    )}
                  </>
                ) : multiSpace ? (
                  spaces.map((space) => {
                    const spaceOptions = moveOptions.filter(
                      (option) => option.space.id === space.id
                    );
                    if (spaceOptions.length === 0) return null;
                    return (
                      <DropdownMenuSub key={space.id}>
                        <DropdownMenuSubTrigger
                          className={cn(
                            MENU_ITEM_CLASS,
                            "cursor-pointer focus:bg-foreground/5 data-[state=open]:bg-foreground/5"
                          )}
                        >
                          <SpaceMenuIcon space={space} />
                          <span className="truncate flex-1">{spaceDisplayName(space, t)}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent
                          sideOffset={4}
                          className={cn(SUB_CONTENT_CLASS, "max-h-40 overflow-y-auto")}
                        >
                          {spaceOptions.map((option) =>
                            renderOption(
                              option,
                              option.target.folderId == null
                                ? t("notes.spaces.spaceRoot")
                                : option.label
                            )
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    );
                  })
                ) : (
                  moveOptions.map((option) => renderOption(option, option.label))
                )}
              </div>
              <DropdownMenuSeparator />
              {isCreating ? (
                <div className="px-1">
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
                    className="input-inline w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/20 outline-none border-none appearance-none"
                  />
                </div>
              ) : (
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setIsCreating(true);
                  }}
                  className={cn(MENU_ITEM_CLASS, "text-foreground/40")}
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
            className={cn(
              MENU_ITEM_CLASS,
              "text-destructive focus:text-destructive focus:bg-destructive/10"
            )}
          >
            <Trash2 size={11} />
            {t("notes.context.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-px" aria-hidden="true">
      {["w-3/5", "w-2/5", "w-1/2"].map((width) => (
        <div key={width} className="flex items-center h-7 pl-[18px] pr-2">
          <div
            className={cn(
              "h-2.5 rounded-full bg-foreground/6 dark:bg-white/6 animate-pulse",
              width
            )}
          />
        </div>
      ))}
    </div>
  );
}

export default function SpacesTree({
  onDeleteNote,
  onMoveNote,
  onCreateFolderAndMove,
  onNewNote,
}: SpacesTreeProps) {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const fileManagerName = useFileManagerName();

  const spaces = useSpaces();
  const folders = useFolders();
  const folderCounts = useFolderCounts();
  const spaceRootCounts = useSpaceRootCounts();
  const notesByContainer = useNotesByContainer();
  const expanded = useExpandedContainers();
  const activeContext = useActiveContext();
  const activeNoteId = useActiveNoteId();
  const isTreeLoading = useIsTreeLoading();
  const teamCapability = useTeamSpacesCapability();
  const { isSignedIn, user } = useAuth();
  const { workspaces } = useWorkspace();
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);

  const [creatingFolderSpaceId, setCreatingFolderSpaceId] = useState<number | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renamingSpaceId, setRenamingSpaceId] = useState<number | null>(null);
  const [renameSpaceName, setRenameSpaceName] = useState("");
  const [renameSpaceEmoji, setRenameSpaceEmoji] = useState("");
  const [spaceRenameFocus, setSpaceRenameFocus] = useState<"name" | "emoji">("name");
  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [membersSpaceId, setMembersSpaceId] = useState<number | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<SpaceItem | null>(null);
  const [deleteNameInput, setDeleteNameInput] = useState("");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const undoToastIdRef = useRef<string | null>(null);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const privateSpaces = useMemo(() => spaces.filter((s) => s.kind === "private"), [spaces]);
  const teamSpaces = useMemo(() => spaces.filter((s) => s.kind === "team"), [spaces]);
  const visibleSpaces = teamCapability ? spaces : privateSpaces;

  // Local-only spaces (no cloud team) stay fully manageable; cloud spaces
  // follow space/workspace roles. Cosmetic — the server enforces.
  const canManageTeamSpace = (space: SpaceItem): boolean =>
    !space.cloud_team_id ||
    canManageSpace(space, workspaces.find((w) => w.id === space.workspace_id)?.role ?? null);

  // Workspace owners/admins access every team implicitly (no team_members
  // row), so a "leave" is a server no-op and the space would resurrect on the
  // next sync pass — Leave is n/a for them (plan §4).
  const hasImplicitSpaceAccess = (space: SpaceItem): boolean => {
    const role = workspaces.find((w) => w.id === space.workspace_id)?.role;
    return role === "owner" || role === "admin";
  };

  const targetLabel = (target: NoteMoveTarget): string => {
    if (target.folderId != null) {
      return folders.find((f) => f.id === target.folderId)?.name ?? "";
    }
    const space = spaces.find((s) => s.id === target.spaceId);
    return space ? spaceDisplayName(space, t) : "";
  };

  const showUndoToast = (title: string, target: string, onUndo: () => void) => {
    if (undoToastIdRef.current) dismiss(undoToastIdRef.current);
    undoToastIdRef.current = toast({
      title: t("notes.spaces.moved", { title, target }),
      duration: 8000,
      action: (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (undoToastIdRef.current) dismiss(undoToastIdRef.current);
            undoToastIdRef.current = null;
            onUndo();
          }}
          className="h-6 px-2 text-xs text-white/70 hover:text-white hover:bg-white/10"
        >
          {t("notes.spaces.undo")}
        </Button>
      ),
    });
  };

  const confirmCrossSpaceMove = (
    fromSpaceId: number,
    toSpaceId: number,
    isFolder: boolean,
    onConfirm: () => void,
    willDisableShare = false
  ) => {
    const intoSpace = spaces.find((s) => s.id === toSpaceId);
    const fromSpace = spaces.find((s) => s.id === fromSpaceId);
    if (!intoSpace || !fromSpace) return;
    const movingIntoTeam = intoSpace.kind === "team";
    const moveInDescription = t(
      isFolder ? "notes.spaces.confirmMoveInFolder" : "notes.spaces.confirmMoveIn",
      { space: intoSpace.name }
    );
    showConfirmDialog({
      title: movingIntoTeam
        ? t("notes.spaces.confirmMoveInTitle", { space: intoSpace.name })
        : t("notes.spaces.confirmMoveOutTitle", { space: fromSpace.name }),
      description: movingIntoTeam
        ? willDisableShare
          ? `${moveInDescription} ${t("notes.spaces.confirmMoveInShared")}`
          : moveInDescription
        : t(isFolder ? "notes.spaces.confirmMoveOutFolder" : "notes.spaces.confirmMoveOut", {
            space: fromSpace.name,
          }),
      confirmText: t("notes.spaces.moveConfirm"),
      onConfirm,
    });
  };

  // D8: team notes never carry a public web link — moving a web-shared note
  // into a team space revokes its share (the confirm dialog announces it).
  const willRevokeShare = (note: NoteItem, toSpaceId: number): boolean =>
    Boolean(note.is_shared && note.cloud_id) &&
    note.space_id !== toSpaceId &&
    spaces.find((s) => s.id === toSpaceId)?.kind === "team";

  const revokePublicShare = async (note: NoteItem) => {
    const cloudId = note.cloud_id;
    if (!cloudId) return;
    try {
      const res = await NoteSharingService.clearShare(cloudId);
      updateShareCache(cloudId, (entry) => ({
        share: res.share,
        invitations: entry?.invitations ?? [],
        rawToken: null,
      }));
      void persistNoteShareState(note.id, { is_shared: 0, share_token: null }).catch(
        (err: unknown) => console.error("Share flag persist failed:", err)
      );
    } catch {
      // Best effort — the move proceeds; the link stays revocable by moving
      // the note back to Personal.
      toast({ title: t("notes.spaces.shareRevokeFailed"), variant: "destructive" });
    }
  };

  const moveNoteSafely = async (noteId: number, target: NoteMoveTarget): Promise<boolean> => {
    try {
      await onMoveNote(noteId, target);
      return true;
    } catch {
      toast({ title: t("notes.spaces.couldNotMoveNote"), variant: "destructive" });
      return false;
    }
  };

  // The 8s undo window outlives the tree snapshot: the restore target may
  // have been deleted (folder) or purged (space) meanwhile. Never restore a
  // note into a container nothing renders — degrade to the space root.
  const undoMoveNote = async (noteId: number, title: string, prev: NoteMoveTarget) => {
    const prevSpace = getSpacesValue().find((s) => s.id === prev.spaceId);
    if (!prevSpace) {
      toast({ title: t("notes.spaces.couldNotMoveNote"), variant: "destructive" });
      return;
    }
    const folderGone =
      prev.folderId != null && !getFoldersValue().some((f) => f.id === prev.folderId);
    const restore = folderGone ? { spaceId: prev.spaceId, folderId: null } : prev;
    const moved = await moveNoteSafely(noteId, restore);
    if (moved && folderGone) {
      toast({ title: t("notes.spaces.moved", { title, target: spaceDisplayName(prevSpace, t) }) });
    }
  };

  const commitMoveNote = async (noteId: number, target: NoteMoveTarget) => {
    const note = getNoteFromStore(noteId);
    const prev: NoteMoveTarget | null = note
      ? { spaceId: note.space_id, folderId: note.folder_id }
      : null;
    if (note && willRevokeShare(note, target.spaceId)) {
      await revokePublicShare(note);
    }
    const moved = await moveNoteSafely(noteId, target);
    if (moved && prev) {
      const title = note?.title || t("notes.list.untitled");
      // Undo silently restores the previous space/folder — no confirm, no new toast.
      showUndoToast(title, targetLabel(target), () => void undoMoveNote(noteId, title, prev));
    }
  };

  const requestMoveNote = (noteId: number, target: NoteMoveTarget) => {
    const note = getNoteFromStore(noteId);
    if (!note) return;
    if (note.space_id !== target.spaceId) {
      confirmCrossSpaceMove(
        note.space_id,
        target.spaceId,
        false,
        () => void commitMoveNote(noteId, target),
        willRevokeShare(note, target.spaceId)
      );
    } else {
      void commitMoveNote(noteId, target);
    }
  };

  const moveFolderSafely = async (
    folderId: number,
    spaceId: number
  ): Promise<{ success: boolean; error?: string }> => {
    const result = await moveFolderToSpace(folderId, spaceId).catch((err: unknown) => ({
      success: false,
      error: (err as Error).message,
    }));
    if (!result.success) {
      toast({
        title: t("notes.spaces.couldNotMove"),
        description: result.error,
        variant: "destructive",
      });
    }
    return result;
  };

  const commitMoveFolder = async (folder: FolderItem, space: SpaceItem) => {
    const prevSpaceId = folder.space_id;
    const result = await moveFolderSafely(folder.id, space.id);
    if (!result.success) return;
    revealContainer(space.id, null);
    showUndoToast(
      folder.name,
      spaceDisplayName(space, t),
      () => void moveFolderSafely(folder.id, prevSpaceId)
    );
  };

  const requestMoveFolder = (folder: FolderItem, space: SpaceItem) => {
    if (space.id === folder.space_id) return;
    confirmCrossSpaceMove(
      folder.space_id,
      space.id,
      true,
      () => void commitMoveFolder(folder, space)
    );
  };

  const { dragState, noteDragHandlers, dropTargetHandlers } = useNoteDragAndDrop({
    onMoveToTarget: commitMoveNote,
    onCrossSpaceDrop: (note: DraggedNoteInfo, target, commit) => {
      const full = getNoteFromStore(note.id);
      confirmCrossSpaceMove(
        note.spaceId,
        target.spaceId,
        false,
        commit,
        full ? willRevokeShare(full, target.spaceId) : false
      );
    },
    onHoverTarget: (key) => setContainerExpanded(key, true),
  });

  const visibleRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const pushSpace = (space: SpaceItem) => {
      const spaceKey = spaceContainerKey(space.id);
      rows.push({ type: "space", key: spaceKey, space });
      if (!expanded.has(spaceKey)) return;
      folders
        .filter((f) => f.space_id === space.id)
        .forEach((folder) => {
          const folderKey = folderContainerKey(folder.id);
          rows.push({ type: "folder", key: folderKey, folder, parentKey: spaceKey });
          if (expanded.has(folderKey)) {
            (notesByContainer[folderKey] ?? []).forEach((note) => {
              rows.push({
                type: "note",
                key: `n:${note.id}`,
                note,
                parentKey: folderKey,
                level: 3,
              });
            });
          }
        });
      (notesByContainer[spaceKey] ?? []).forEach((note) => {
        rows.push({ type: "note", key: `n:${note.id}`, note, parentKey: spaceKey, level: 2 });
      });
    };
    privateSpaces.forEach(pushSpace);
    if (teamCapability) teamSpaces.forEach(pushSpace);
    return rows;
  }, [privateSpaces, teamSpaces, folders, notesByContainer, expanded, teamCapability]);

  const effectiveFocusKey =
    focusedKey && visibleRows.some((r) => r.key === focusedKey)
      ? focusedKey
      : (visibleRows[0]?.key ?? null);

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusedKey(key);
    rowRefs.current.get(key)?.focus();
  };

  /** Restore focus to a row after an inline input closes (keyboard paths only). */
  const focusRowSoon = (key: string) => {
    setFocusedKey(key);
    requestAnimationFrame(() => rowRefs.current.get(key)?.focus());
  };

  const activateRow = (row: TreeRow) => {
    if (row.type === "space") {
      setActiveContext(row.space.id, null);
      toggleContainerExpanded(row.key);
    } else if (row.type === "folder") {
      setActiveContext(row.folder.space_id, row.folder.id);
      toggleContainerExpanded(row.key);
    } else {
      setActiveNoteId(row.note.id);
    }
  };

  const startRenameFolder = (folder: FolderItem) => {
    setRenamingFolderId(folder.id);
    setRenameValue(folder.name);
  };

  const startRenameSpace = (space: SpaceItem, focus: "name" | "emoji") => {
    setRenamingSpaceId(space.id);
    setRenameSpaceName(space.name);
    setRenameSpaceEmoji(space.emoji ?? "");
    setSpaceRenameFocus(focus);
  };

  const requestDeleteFolder = (folder: FolderItem) => {
    const count = folderCounts[folder.id] ?? 0;
    showConfirmDialog({
      title: t("notes.folders.deleteTitle"),
      description:
        count > 0
          ? t("notes.folders.deleteDescription", { name: folder.name, count })
          : t("notes.folders.deleteDescriptionEmpty", { name: folder.name }),
      confirmText: t("notes.folders.deleteConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        const result = await deleteFolder(folder.id);
        if (!result.success && result.error) {
          toast({
            title: t("notes.folders.couldNotDelete"),
            description: result.error,
            variant: "destructive",
          });
        }
      },
    });
  };

  const requestDeleteSpace = (space: SpaceItem) => {
    setDeleteNameInput("");
    setDeleteSpaceTarget(space);
  };

  const closeDeleteSpaceDialog = () => {
    setDeleteSpaceTarget(null);
    setDeleteNameInput("");
  };

  const performDeleteSpace = async (space: SpaceItem) => {
    if (space.cloud_team_id) {
      try {
        // Server archives the team; teammates purge on their next spaces pass.
        await TeamsService.remove(space.cloud_team_id);
      } catch (err) {
        toast({
          title: t("notes.spaces.couldNotDelete"),
          description: err instanceof Error ? err.message : t("common.unknownError"),
          variant: "destructive",
        });
        return;
      }
      // Park the team id so an in-flight pull can't resurrect purged rows.
      markTeamSpacePurged(space.cloud_team_id);
    }
    const result = await purgeSpace(space.id);
    if (!result.success && result.error) {
      toast({
        title: t("notes.spaces.couldNotDelete"),
        description: result.error,
        variant: "destructive",
      });
      return;
    }
    toast({ title: t("notes.spaces.deleted", { space: space.name }) });
  };

  const requestLeaveSpace = (space: SpaceItem) => {
    if (!space.cloud_team_id || !user?.id) return;
    const teamId = space.cloud_team_id;
    const userId = user.id;
    showConfirmDialog({
      title: t("notes.spaces.members.leaveConfirm", { space: space.name }),
      description: t("notes.spaces.members.leaveConfirmDescription"),
      confirmText: t("notes.spaces.members.leave"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          // The member DELETE succeeds even when no roster row exists, so an
          // implicit workspace owner/admin "leave" would purge locally only to
          // resurrect on the next pass — never purge for a server no-op.
          const roster = await TeamsService.listMembers(teamId);
          if (hasImplicitSpaceAccess(space) || !roster.some((m) => m.user_id === userId)) {
            toast({ title: t("notes.spaces.members.implicitAdminCannotLeave") });
            return;
          }
          await TeamsService.removeMember(teamId, userId);
          markTeamSpacePurged(teamId);
          await purgeSpace(space.id);
        } catch (err) {
          // Server rejected the leave — surface its message.
          toast({
            title: t("common.error"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      },
    });
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    if (e.target !== e.currentTarget) return;
    const idx = visibleRows.findIndex((r) => r.key === row.key);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (activeContext) onNewNote(activeContext.spaceId, activeContext.folderId);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(visibleRows[idx + 1]?.key);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(visibleRows[idx - 1]?.key);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row.type === "note") break;
        if (!expanded.has(row.key)) {
          setContainerExpanded(row.key, true);
        } else if (visibleRows[idx + 1]?.parentKey === row.key) {
          focusRow(visibleRows[idx + 1]?.key);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.type !== "note" && expanded.has(row.key)) {
          setContainerExpanded(row.key, false);
        } else if (row.parentKey) {
          focusRow(row.parentKey);
        }
        break;
      case "F2":
        e.preventDefault();
        if (row.type === "folder" && !row.folder.is_default) {
          startRenameFolder(row.folder);
        } else if (
          row.type === "space" &&
          row.space.kind === "team" &&
          canManageTeamSpace(row.space)
        ) {
          startRenameSpace(row.space, "name");
        }
        break;
      case "Delete":
      case "Backspace":
        // Bare Backspace stays inert; Cmd/Ctrl+Backspace matches the native delete gesture.
        if (e.key === "Backspace" && !(e.metaKey || e.ctrlKey)) break;
        e.preventDefault();
        if (row.type === "note") {
          focusRow(visibleRows[idx + 1]?.key ?? visibleRows[idx - 1]?.key);
          onDeleteNote(row.note.id);
        } else if (row.type === "folder" && !row.folder.is_default) {
          requestDeleteFolder(row.folder);
        } else if (
          row.type === "space" &&
          row.space.kind === "team" &&
          canManageTeamSpace(row.space)
        ) {
          requestDeleteSpace(row.space);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        activateRow(row);
        break;
    }
  };

  const a11yFor = (key: string): RowA11yProps => ({
    tabIndex: key === effectiveFocusKey ? 0 : -1,
    rowRef: (el) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    onKeyDown: (e) => {
      const row = visibleRows.find((r) => r.key === key);
      if (row) handleRowKeyDown(e, row);
    },
    onFocus: () => setFocusedKey(key),
  });

  const startCreateFolder = (space: SpaceItem) => {
    setContainerExpanded(spaceContainerKey(space.id), true);
    setCreatingFolderSpaceId(space.id);
    setNewFolderName("");
  };

  const confirmCreateFolder = async (): Promise<string | null> => {
    const spaceId = creatingFolderSpaceId;
    const trimmed = newFolderName.trim();
    setCreatingFolderSpaceId(null);
    setNewFolderName("");
    if (spaceId == null || !trimmed) return null;
    const result = await createFolder(trimmed, spaceId);
    if (result.success && result.folder) {
      setActiveContext(spaceId, result.folder.id);
      return folderContainerKey(result.folder.id);
    }
    if (result.error) {
      toast({
        title: t("notes.folders.couldNotCreate"),
        description: result.error,
        variant: "destructive",
      });
    }
    return null;
  };

  const confirmRename = async () => {
    const folderId = renamingFolderId;
    const trimmed = renameValue.trim();
    setRenamingFolderId(null);
    setRenameValue("");
    if (folderId == null || !trimmed) return;
    const result = await renameFolder(folderId, trimmed);
    if (!result.success && result.error) {
      toast({
        title: t("notes.folders.couldNotRename"),
        description: result.error,
        variant: "destructive",
      });
    }
  };

  const confirmSpaceRename = async () => {
    const spaceId = renamingSpaceId;
    if (spaceId == null) return;
    const space = spaces.find((s) => s.id === spaceId);
    const name = renameSpaceName.trim();
    const emoji = renameSpaceEmoji.trim() || null;
    setRenamingSpaceId(null);
    if (!space || !name) return;
    if (name === space.name && emoji === (space.emoji ?? null)) return;
    // Optimistic local rename; the server call below reverts it on rejection.
    const result = await updateSpaceMeta(spaceId, { name, emoji });
    if (!result.success) {
      if (result.error) {
        toast({
          title: t("notes.spaces.couldNotRename"),
          description: result.error,
          variant: "destructive",
        });
      }
      return;
    }
    if (!space.cloud_team_id) return;
    try {
      await TeamsService.update(space.cloud_team_id, { name, emoji });
    } catch (err) {
      await updateSpaceMeta(spaceId, { name: space.name, emoji: space.emoji ?? null });
      toast({
        title: t("notes.spaces.couldNotRename"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  };

  const renderNote = (note: NoteItem, level: 2 | 3, parentKey: string) => (
    <NoteLeaf
      key={note.id}
      note={note}
      level={level}
      isActive={note.id === activeNoteId}
      isDragging={dragState.draggingNoteId === note.id}
      dragHandlers={noteDragHandlers({
        id: note.id,
        title: note.title,
        folderId: note.folder_id,
        spaceId: note.space_id,
      })}
      spaces={visibleSpaces}
      folders={folders}
      noteFilesEnabled={noteFilesEnabled}
      fileManagerName={fileManagerName}
      onOpen={() => activateRow({ type: "note", key: `n:${note.id}`, note, parentKey, level })}
      onMove={(target) => requestMoveNote(note.id, target)}
      onCreateFolderAndMove={onCreateFolderAndMove}
      onDelete={onDeleteNote}
      a11y={a11yFor(`n:${note.id}`)}
      t={t}
    />
  );

  const renderFolder = (folder: FolderItem, parentKey: string) => {
    const folderKey = folderContainerKey(folder.id);
    const isExpanded = expanded.has(folderKey);
    const isRenaming = renamingFolderId === folder.id;

    if (isRenaming) {
      return (
        <div key={folder.id} role="none" className="pl-[14px] pr-2">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirmRename();
                focusRowSoon(folderKey);
              }
              if (e.key === "Escape") {
                setRenamingFolderId(null);
                setRenameValue("");
                focusRowSoon(folderKey);
              }
            }}
            onBlur={confirmRename}
            className={FOLDER_INPUT_CLASS}
          />
        </div>
      );
    }

    return (
      <div key={folder.id} role="none">
        <FolderRow
          folder={folder}
          spaces={visibleSpaces}
          isExpanded={isExpanded}
          isActive={activeContext?.folderId === folder.id}
          count={folderCounts[folder.id] ?? 0}
          isDragOver={dragState.dragOverKey === folderKey}
          isDropSuccess={dragState.dropSuccessKey === folderKey}
          dropHandlers={dropTargetHandlers({
            spaceId: folder.space_id,
            folderId: folder.id,
            folderName: folder.name,
            isDefaultFolder: Boolean(folder.is_default),
          })}
          noteFilesEnabled={noteFilesEnabled}
          fileManagerName={fileManagerName}
          onActivate={() => activateRow({ type: "folder", key: folderKey, folder, parentKey })}
          onToggle={() => toggleContainerExpanded(folderKey)}
          onRename={() => startRenameFolder(folder)}
          onMoveToSpace={(space) => requestMoveFolder(folder, space)}
          onDelete={() => requestDeleteFolder(folder)}
          a11y={a11yFor(folderKey)}
          t={t}
        />
        <TreeChildren open={isExpanded}>
          <div className="space-y-px">
            {(notesByContainer[folderKey] ?? []).map((note) => renderNote(note, 3, folderKey))}
          </div>
        </TreeChildren>
      </div>
    );
  };

  const renderSpace = (space: SpaceItem) => {
    const spaceKey = spaceContainerKey(space.id);
    const isExpanded = expanded.has(spaceKey);
    const spaceFolders = folders.filter((f) => f.space_id === space.id);
    const rootNotes = notesByContainer[spaceKey];
    const displayName = spaceDisplayName(space, t);
    // DB-backed counts: space-root notes count before their container loads,
    // and the root contribution isn't capped at the container's page size.
    const noteCount =
      spaceFolders.reduce((sum, f) => sum + (folderCounts[f.id] ?? 0), 0) +
      (spaceRootCounts[space.id] ?? 0);
    const showSkeletons =
      space.kind === "team" &&
      space.sync_status === "pending" &&
      spaceFolders.length === 0 &&
      rootNotes === undefined;
    const showEmptySpace =
      space.kind === "team" && spaceFolders.length === 0 && rootNotes?.length === 0;

    return (
      <div key={space.id} role="none">
        {renamingSpaceId === space.id ? (
          <div
            role="none"
            className="flex items-center gap-1 h-[30px] px-2"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                confirmSpaceRename();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                confirmSpaceRename();
                focusRowSoon(spaceKey);
              }
              if (e.key === "Escape") {
                setRenamingSpaceId(null);
                focusRowSoon(spaceKey);
              }
            }}
          >
            <input
              autoFocus={spaceRenameFocus === "emoji"}
              value={renameSpaceEmoji}
              onChange={(e) => setRenameSpaceEmoji(e.target.value)}
              maxLength={4}
              aria-label={t("notes.spaces.changeEmoji")}
              className={cn(FOLDER_INPUT_CLASS, "w-8 shrink-0 px-0 text-center")}
            />
            <input
              autoFocus={spaceRenameFocus === "name"}
              value={renameSpaceName}
              onChange={(e) => setRenameSpaceName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t("notes.spaces.rename")}
              className={FOLDER_INPUT_CLASS}
            />
          </div>
        ) : (
          <SpaceRow
            space={space}
            displayName={displayName}
            isExpanded={isExpanded}
            isActive={activeContext?.spaceId === space.id && activeContext.folderId == null}
            count={noteCount}
            isDragOver={dragState.dragOverKey === spaceKey}
            isDropSuccess={dragState.dropSuccessKey === spaceKey}
            dropHandlers={dropTargetHandlers({ spaceId: space.id, folderId: null })}
            canManage={canManageTeamSpace(space)}
            canLeave={!hasImplicitSpaceAccess(space)}
            onActivate={() => activateRow({ type: "space", key: spaceKey, space })}
            onToggle={() => toggleContainerExpanded(spaceKey)}
            onNewFolder={() => startCreateFolder(space)}
            onMembers={() => setMembersSpaceId(space.id)}
            onRename={(focus) => startRenameSpace(space, focus)}
            onLeave={() => requestLeaveSpace(space)}
            onDelete={() => requestDeleteSpace(space)}
            a11y={a11yFor(spaceKey)}
            t={t}
          />
        )}
        <TreeChildren open={isExpanded}>
          <div className="space-y-px">
            {spaceFolders.map((folder) => renderFolder(folder, spaceKey))}
            {creatingFolderSpaceId === space.id && (
              <div className="pl-[14px] pr-2">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void confirmCreateFolder().then((key) => key && focusRowSoon(key));
                    }
                    if (e.key === "Escape") {
                      setCreatingFolderSpaceId(null);
                      setNewFolderName("");
                      focusRowSoon(spaceKey);
                    }
                  }}
                  onBlur={confirmCreateFolder}
                  placeholder={t("notes.folders.folderName")}
                  className={cn(FOLDER_INPUT_CLASS, "placeholder:text-foreground/20")}
                />
              </div>
            )}
            {(rootNotes ?? []).map((note) => renderNote(note, 2, spaceKey))}
            {showSkeletons && <SkeletonRows />}
            {showEmptySpace && (
              <div className="pl-[18px] pr-2 py-1">
                <p className="text-xs text-foreground/40 leading-relaxed mb-1.5">
                  {t("notes.spaces.emptySpace", { space: space.name })}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNewNote(space.id, null)}
                  className="h-6 px-2 text-xs gap-1 text-primary/70 hover:text-primary hover:bg-primary/8"
                >
                  <Plus size={11} />
                  {t("notes.list.newNote")}
                </Button>
              </div>
            )}
          </div>
        </TreeChildren>
      </div>
    );
  };

  const membersSpace =
    membersSpaceId != null ? spaces.find((s) => s.id === membersSpaceId) : undefined;

  if (isTreeLoading && spaces.length === 0) {
    return (
      <div className="flex-1 flex items-start justify-center py-8">
        <Loader2 size={12} className="animate-spin text-foreground/15" />
      </div>
    );
  }

  return (
    <>
      <div
        role="tree"
        aria-label={t("notes.list.title")}
        className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-px"
      >
        <SectionHeader label={t("notes.spaces.privateSpaces")} />
        {privateSpaces.map(renderSpace)}
        {teamCapability && (
          <div role="none" className="group/section">
            <SectionHeader
              label={t("notes.spaces.teamSpaces")}
              className="mt-3"
              action={
                isSignedIn ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("notes.spaces.newSpace")}
                    onClick={() => setShowCreateSpace(true)}
                    className={cn(
                      "h-5 w-5 rounded-sm opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100",
                      "transition-opacity text-muted-foreground/60 dark:text-muted-foreground/40",
                      "hover:text-foreground/60 hover:bg-foreground/5 active:bg-foreground/8"
                    )}
                  >
                    <Plus size={12} />
                  </Button>
                ) : undefined
              }
            />
            {teamSpaces.map(renderSpace)}
          </div>
        )}
      </div>

      <CreateSpaceDialog open={showCreateSpace} onOpenChange={setShowCreateSpace} />

      {membersSpace && (
        <SpaceMembersDialog
          space={membersSpace}
          open
          onOpenChange={(open) => !open && setMembersSpaceId(null)}
        />
      )}

      <ConfirmDialog
        open={deleteSpaceTarget != null}
        onOpenChange={(open) => !open && closeDeleteSpaceDialog()}
        title={t("notes.spaces.deleteConfirmTitle")}
        description={
          deleteSpaceTarget
            ? t(
                deleteSpaceTarget.cloud_team_id
                  ? "notes.spaces.deleteConfirmTeamDescription"
                  : "notes.spaces.deleteConfirmDescription",
                { space: deleteSpaceTarget.name }
              )
            : undefined
        }
        confirmText={t("notes.spaces.deleteSpace")}
        variant="destructive"
        confirmDisabled={deleteNameInput.trim() !== deleteSpaceTarget?.name}
        onConfirm={() => {
          if (deleteSpaceTarget) void performDeleteSpace(deleteSpaceTarget);
        }}
      >
        {deleteSpaceTarget && (
          <div className="space-y-1.5">
            <label htmlFor="delete-space-name" className="text-xs font-medium text-foreground/50">
              {t("notes.spaces.deleteTypeName", { space: deleteSpaceTarget.name })}
            </label>
            <Input
              id="delete-space-name"
              autoFocus
              value={deleteNameInput}
              onChange={(e) => setDeleteNameInput(e.target.value)}
              placeholder={deleteSpaceTarget.name}
              onKeyDown={(e) => {
                if (e.key === "Enter" && deleteNameInput.trim() === deleteSpaceTarget.name) {
                  void performDeleteSpace(deleteSpaceTarget);
                  closeDeleteSpaceDialog();
                }
              }}
            />
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </>
  );
}
