import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import { Search, FileText, Check } from "../icons";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { formatDateGroup } from "../../utils/dateFormatting";
import { useFolders, useShareCache, useSpaces } from "../../stores/noteStore";
import { useSpacesInWorkspaceScope, useWorkspace } from "../../hooks/useWorkspace";
import { useAuth } from "../../hooks/useAuth";
import { canChangeSpaceNoteScope, spaceTransferAction } from "../../lib/spacePermissions";
import { canOrganizeNote, resolveNotePermission } from "../../lib/notePermissions";
import { privateSectionSpaces } from "../../lib/privateSection";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { useToast } from "../ui/useToast";
import type { NoteItem, NoteMutationResult } from "../../types/electron";

interface AddNotesToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetFolderId: number;
  onNotesAdded: () => void;
}

function groupNotesByDate(
  notes: NoteItem[],
  t: (key: string) => string,
  locale: string
): [string, NoteItem[]][] {
  const groups = new Map<string, NoteItem[]>();
  for (const note of notes) {
    const key = formatDateGroup(note.updated_at, t, locale);
    const arr = groups.get(key) || [];
    arr.push(note);
    groups.set(key, arr);
  }
  return Array.from(groups.entries());
}

export default function AddNotesToFolderDialog({
  open,
  onOpenChange,
  targetFolderId,
  onNotesAdded,
}: AddNotesToFolderDialogProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [allNotes, setAllNotes] = useState<NoteItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  // The tree's scope: adding a note moves it into this folder's space, so one the tree hides
  // (another workspace's teamspace or Private) must never be offered. The query always names the
  // spaces in scope, so a space the store hasn't read (a Private made since) can't let its notes
  // through.
  const spaces = useSpaces();
  const visibleSpaces = useSpacesInWorkspaceScope(spaces);
  const visibleSpaceIds = useMemo(() => visibleSpaces.map((s) => s.id), [visibleSpaces]);
  const folders = useFolders();
  const shareByCloudId = useShareCache();
  const { user } = useAuth();
  const { workspaces, defaultWorkspaceId } = useWorkspace();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelected(new Set());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.electronAPI.getNotes(null, 500, null, null, visibleSpaceIds).then(setAllNotes);
  }, [open, visibleSpaceIds]);

  // Adding a note moves it into the folder's space, so it follows the tree's move rules: a note
  // from that space, or one spaceTransferAction lets move there that the user may move. A team
  // note never becomes private this way (Copy to Private makes a private copy); main refuses a
  // synced one anyway.
  const availableNotes = useMemo(() => {
    const targetSpaceId = folders.find((f) => f.id === targetFolderId)?.space_id;
    const to = spaces.find((s) => s.id === targetSpaceId);
    if (!to) return [];
    // As the tree's crossesUnknownWorkspace: until the default workspace is known, the Private
    // section's pending Private may be another workspace's, so a move between its Privates could
    // cross workspaces.
    const sectionIds = new Set(privateSectionSpaces(visibleSpaces).map((space) => space.id));
    const crossesUnknownWorkspace = (fromId: number): boolean =>
      defaultWorkspaceId == null &&
      fromId !== to.id &&
      sectionIds.has(fromId) &&
      sectionIds.has(to.id);
    return allNotes.filter((note) => {
      if (note.folder_id === targetFolderId) return false;
      const from = spaces.find((s) => s.id === note.space_id);
      if (!from) return false;
      const isTeamNote = from.kind === "team";
      const entry = note.cloud_id ? shareByCloudId.get(note.cloud_id) : null;
      const permission = resolveNotePermission({
        cachedPermission: entry?.access?.my_permission,
        aclState: entry ? "loaded" : "unavailable",
        isTeamNote,
      });
      if (!canOrganizeNote(permission, { isTeamNote, hasCloudCopy: !!note.cloud_id })) {
        return false;
      }
      if (from.id === to.id) return true;
      if (crossesUnknownWorkspace(from.id)) return false;
      if (spaceTransferAction(from, to, { defaultWorkspaceId }) !== "move") return false;
      const workspace = workspaces.find((w) => w.id === from.workspace_id) ?? null;
      return canChangeSpaceNoteScope(note, from, user?.id ?? null, workspace);
    });
  }, [
    allNotes,
    targetFolderId,
    folders,
    spaces,
    visibleSpaces,
    shareByCloudId,
    defaultWorkspaceId,
    workspaces,
    user?.id,
  ]);

  const filteredNotes = useMemo(() => {
    if (!search.trim()) return availableNotes;
    const q = search.toLowerCase();
    return availableNotes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    );
  }, [availableNotes, search]);

  const grouped = useMemo(
    () => groupNotesByDate(filteredNotes, t, locale),
    [filteredNotes, t, locale]
  );

  const toggleNote = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAdd = useCallback(async () => {
    if (selected.size === 0) return;
    setIsAdding(true);
    try {
      const results = await Promise.all(
        Array.from(selected).map(async (id) => {
          let result: NoteMutationResult;
          try {
            result = await window.electronAPI.updateNote(id, { folder_id: targetFolderId });
          } catch (error) {
            result = { success: false, error: (error as Error)?.message };
          }
          return { id, result };
        })
      );
      // Main refuses some moves (D31: a team note the cloud has never becomes private), and the
      // list can be stale: say what didn't move instead of closing as if it had.
      const refused = results.filter(({ result }) => result?.success === false);
      if (refused.length < results.length) onNotesAdded();
      if (refused.length > 0) {
        const [first] = refused;
        const firstNote = allNotes.find((note) => note.id === first.id);
        const space = spaces.find((s) => s.id === firstNote?.space_id);
        toast({
          title: t("notes.addToFolder.notAdded", { count: refused.length }),
          description:
            first.result.code === "team_row_synced" && space
              ? t("notes.spaces.noteAlreadyInTeam", {
                  title: firstNote?.title || t("notes.list.untitled"),
                  space: space.name,
                })
              : t(localMutationErrorKey(first.result.error)),
          variant: "destructive",
        });
      }
      onOpenChange(false);
    } finally {
      setIsAdding(false);
    }
  }, [selected, targetFolderId, onNotesAdded, onOpenChange, allNotes, spaces, t, toast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-96 p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t("notes.addToFolder.title")}</DialogTitle>

        <div className="px-4 pe-12 pt-4 pb-2">
          <div className="relative">
            <Search
              size={13}
              className="absolute start-2.5 top-1/2 -translate-y-1/2 text-foreground/45"
            />
            <input
              dir="auto"
              placeholder={t("notes.addToFolder.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/8 dark:border-white/10 ps-8 pe-3 text-xs text-foreground placeholder:text-foreground/45 outline-none focus:border-primary/30 transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto px-2 pb-2">
          {grouped.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <p className="text-xs text-foreground/45">
                {search
                  ? t("notes.addToFolder.noResults")
                  : t("notes.addToFolder.noNotesAvailable")}
              </p>
            </div>
          ) : (
            grouped.map(([dateLabel, notes]) => (
              <div key={dateLabel}>
                <p className="text-xs font-medium text-foreground/45 px-2 pt-3 pb-1.5">
                  {dateLabel}
                </p>
                {notes.map((note) => {
                  const isSelected = selected.has(note.id);
                  return (
                    <button
                      key={note.id}
                      onClick={() => toggleNote(note.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors",
                        "hover:bg-foreground/3 dark:hover:bg-white/3",
                        isSelected && "bg-primary/5 dark:bg-primary/8"
                      )}
                    >
                      <div className="w-7 h-7 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/6 dark:border-white/10 flex items-center justify-center shrink-0">
                        <FileText size={12} className="text-foreground/45" />
                      </div>
                      <div className="flex-1 min-w-0 text-start">
                        <p className="text-xs text-foreground/80 truncate">
                          {note.title || t("notes.list.untitled")}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "w-4 h-4 rounded-[3px] border shrink-0 flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-primary border-primary"
                            : "border-foreground/15 dark:border-white/15"
                        )}
                      >
                        {isSelected && <Check size={10} className="text-white" strokeWidth={2.5} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border/70 dark:border-white/10 flex justify-end">
          <Button
            variant="default"
            size="sm"
            onClick={handleAdd}
            disabled={selected.size === 0 || isAdding}
            className="h-7 text-xs"
          >
            {t("notes.addToFolder.addCount", { count: selected.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
