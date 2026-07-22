import { useEffect, useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import InviteTeammateDialog from "../../InviteTeammateDialog";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { canManageSpace } from "../../../lib/spacePermissions";
import {
  useNotes,
  useNotesByContainer,
  useFolders,
  useFolderCounts,
  useSpaceRootCounts,
} from "../../../stores/noteStore";
import { useContainerChat } from "../../../hooks/useContainerChat";
import { ContainerIcon } from "./ContainerIcon";
import { OverviewExplainerBanner } from "./OverviewExplainerBanner";
import { OverviewAskSection } from "./OverviewAskSection";
import { OverviewNoteList } from "./OverviewNoteList";
import type { NoteItem, SpaceItem, FolderItem } from "../../../types/electron";

const SPACE_NOTES_LIMIT = 50;

interface ContainerOverviewProps {
  space: SpaceItem;
  folder: FolderItem | null;
  onOpenNote: (noteId: number) => void;
  onNewNote: () => void;
  onAddExisting?: () => void;
}

export function ContainerOverview({
  space,
  folder,
  onOpenNote,
  onNewNote,
  onAddExisting,
}: ContainerOverviewProps) {
  const { t } = useTranslation();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const folders = useFolders();
  const containerNotes = useNotes();
  const notesByContainer = useNotesByContainer();
  const folderCounts = useFolderCounts();
  const spaceRootCounts = useSpaceRootCounts();
  const [spaceNotes, setSpaceNotes] = useState<NoteItem[] | null>(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);

  // Folder overviews mirror the store's active container; space overviews list
  // the whole space (foldered + root), which the store doesn't hold — fetched
  // here and refreshed whenever any container's notes change.
  useEffect(() => {
    if (folder) return;
    let stale = false;
    window.electronAPI
      .getSpaceNotes(space.id, SPACE_NOTES_LIMIT)
      .then((rows) => {
        if (!stale) setSpaceNotes(rows ?? []);
      })
      .catch(() => {
        if (!stale) setSpaceNotes([]);
      });
    return () => {
      stale = true;
    };
  }, [folder, space.id, notesByContainer]);

  const notes = folder ? containerNotes : (spaceNotes ?? []);

  const chat = useContainerChat({ space, folder, notes });

  const workspace = space.workspace_id
    ? workspaces.find((w) => w.id === space.workspace_id)
    : undefined;
  const canInvite =
    space.kind === "team" &&
    !!space.cloud_team_id &&
    !!workspace &&
    canManageSpace(space, workspace.role ?? null);

  const spaceFolders = useMemo(
    () => folders.filter((f) => f.space_id === space.id),
    [folders, space.id]
  );
  // DB-backed counts, as in SpacesTree: the visible list is capped at the
  // container page size, so notes.length undercounts large containers.
  const noteCount = folder
    ? (folderCounts[folder.id] ?? notes.length)
    : spaceFolders.reduce((sum, f) => sum + (folderCounts[f.id] ?? 0), 0) +
      (spaceRootCounts[space.id] ?? 0);

  const metaParts: string[] = [];
  if (space.kind === "team" && workspace) metaParts.push(workspace.name);
  if (!folder && spaceFolders.length > 0) {
    metaParts.push(t("notes.overview.meta.folders", { count: spaceFolders.length }));
  }
  metaParts.push(t("notes.spaces.noteCount", { count: noteCount }));
  if (space.kind === "team" && space.member_count != null) {
    metaParts.push(t("notes.overview.meta.members", { count: space.member_count }));
  }

  return (
    <div className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-2xl mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="flex flex-col items-center text-center gap-2 pt-4">
          <div className="h-12 w-12 rounded-xl bg-foreground/4 dark:bg-white/5 border border-border/25 dark:border-white/8 flex items-center justify-center mb-1">
            <ContainerIcon space={space} folder={folder} size={20} />
          </div>
          <h1 className="text-xl font-semibold text-foreground tracking-tight">
            {folder?.name ?? space.name}
          </h1>
          <p className="text-[13px] text-foreground/50 dark:text-foreground/40">
            {t(`notes.overview.subtitle.${space.kind === "team" ? "team" : "private"}`)}
          </p>
          <p className="text-xs text-foreground/35 dark:text-foreground/25">
            {metaParts.join(" · ")}
          </p>
          {canInvite && (
            <button
              onClick={() => setShowInviteDialog(true)}
              className="mt-1 inline-flex items-center gap-1.5 px-3 h-7 rounded-md border border-border/40 dark:border-white/10 text-xs font-medium text-foreground/60 hover:text-foreground/85 hover:border-border/70 hover:bg-foreground/3 dark:hover:bg-white/3 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
            >
              <UserPlus size={12} />
              {t("notes.overview.invite")}
            </button>
          )}
        </div>

        <OverviewExplainerBanner kind={space.kind === "team" ? "team" : "private"} />

        <OverviewAskSection
          messages={chat.messages}
          agentState={chat.agentState}
          onTextSubmit={chat.sendMessage}
          onCancel={chat.cancelStream}
          conversations={chat.conversations}
          activeConversationId={chat.activeConversationId}
          onSwitchConversation={chat.switchConversation}
          onNewChat={chat.startNewChat}
          onOpenNote={onOpenNote}
        />

        <div className="border-t border-border/20 dark:border-white/5">
          <OverviewNoteList
            notes={notes}
            space={space}
            onOpenNote={onOpenNote}
            onNewNote={onNewNote}
            onAddExisting={onAddExisting}
          />
        </div>
      </div>

      {canInvite && workspace && space.cloud_team_id && (
        <InviteTeammateDialog
          open={showInviteDialog}
          onOpenChange={setShowInviteDialog}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          teamIds={[space.cloud_team_id]}
        />
      )}
    </div>
  );
}
