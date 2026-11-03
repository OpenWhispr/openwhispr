import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Plus } from "../icons";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import CreateSpaceDialog from "../notes/CreateSpaceDialog";
import DeleteSpaceDialog from "../notes/DeleteSpaceDialog";
import SpaceSettingsDialog from "../notes/SpaceSettingsDialog";
import { useAuth } from "../../hooks/useAuth";
import { useWorkspaceSpaces } from "../../hooks/useWorkspaceSpaces";
import { workspaceCan } from "../../lib/capabilities";
import { rosterFor } from "../../lib/peopleRoster";
import { classifySpaceError } from "../../lib/workspaceErrors";
import { joinSpace, localSpaceIdFor } from "../../services/spaceActions";
import { getSpacesValue, loadSpaces, useSpaces } from "../../stores/noteStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isolate } from "../../utils/bidiIsolate";
import type {
  SpaceAdminContact,
  SpaceItem,
  Workspace,
  WorkspaceMember,
  WorkspaceSpace,
} from "../../types/electron";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import TeamspacesTable from "./TeamspacesTable";
import { useSettingsWorkspace } from "./useSettingsWorkspace";

interface Props {
  /** Takes the user to a teamspace in Notes. */
  onOpenTeamspace?: (localSpaceId: number) => void;
}

// Who to ask when a teamspace names no admin. The owner and the admins reach every teamspace, so
// they can add the asker. Role is only what puts someone on this list; no permission rests on it.
function workspaceAdminContacts(roster: WorkspaceMember[]): SpaceAdminContact[] {
  const owners = roster.filter((member) => member.role === "owner");
  const admins = roster.filter((member) => member.role === "admin");
  return [...owners, ...admins].map(({ user_id, name, email, image }) => ({
    user_id,
    name,
    email,
    image,
  }));
}

// What the directory shows of the teamspaces the user is in, which the local mirror also holds.
// A change here (a rename, a delete, a join or leave elsewhere) leaves the directory out of date.
function mirrorSignature(spaces: SpaceItem[], workspaceId: string): string {
  return JSON.stringify(
    spaces
      .filter((space) => space.workspace_id === workspaceId && space.cloud_space_id)
      .map((space) => [
        space.cloud_space_id,
        space.name,
        space.emoji,
        space.my_role,
        space.my_direct_role ?? null,
      ])
      .sort()
  );
}

export default function WorkspaceTeamspacesSection({
  onOpenTeamspace,
}: Props): React.ReactElement | null {
  const state = useSettingsWorkspace();
  return (
    <SettingsWorkspaceFrame state={state}>
      {(workspace) => (
        <TeamspacesPage
          key={workspace.id}
          workspace={workspace}
          onOpenTeamspace={onOpenTeamspace}
        />
      )}
    </SettingsWorkspaceFrame>
  );
}

interface PageProps {
  workspace: Workspace;
  onOpenTeamspace?: (localSpaceId: number) => void;
}

function TeamspacesPage({ workspace, onOpenTeamspace }: PageProps): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { status, spaces, reload } = useWorkspaceSpaces(workspace.id);
  const mirror = useSpaces();
  const { roster, refreshMembers } = useWorkspaceStore(
    useShallow((state) => ({
      roster: rosterFor(state, workspace.id),
      refreshMembers: state.refreshMembers,
    }))
  );
  const canCreate = workspaceCan(workspace, "create_spaces");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsSpaceId, setSettingsSpaceId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SpaceItem | null>(null);
  // The row button the delete was started from, which focus goes back to if it is called off.
  const deleteOriginRef = useRef<HTMLElement | null>(null);
  const [joiningIds, setJoiningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [adminsLoading, setAdminsLoading] = useState(false);
  // A second press before the button has re-rendered as disabled must not join twice.
  const joiningRef = useRef(new Set<string>());

  const workspaceAdmins = useMemo(() => workspaceAdminContacts(roster), [roster]);
  const settingsSpace =
    settingsSpaceId != null ? mirror.find((space) => space.id === settingsSpaceId) : undefined;

  // The directory is read from the server, but the dialogs change the mirror first. Reading it
  // again when the mirror changes keeps a renamed or deleted teamspace from lingering here.
  const mirrorKey = useMemo(() => mirrorSignature(mirror, workspace.id), [mirror, workspace.id]);
  const seenMirrorKey = useRef(mirrorKey);
  useEffect(() => {
    if (seenMirrorKey.current === mirrorKey) return;
    seenMirrorKey.current = mirrorKey;
    void reload();
  }, [mirrorKey, reload]);

  const loadWorkspaceAdmins = useCallback((): void => {
    setAdminsLoading(true);
    // A failed read is logged by the store; the list keeps what the cache holds.
    void refreshMembers(workspace.id)
      .catch(() => undefined)
      .finally(() => setAdminsLoading(false));
  }, [refreshMembers, workspace.id]);

  // The teamspace as the local mirror holds it, which is what the dialogs and Notes open. A
  // directory row with no local copy (the sync hasn't brought it yet) says so rather than doing
  // nothing.
  async function resolveLocalSpace(space: WorkspaceSpace): Promise<SpaceItem | null> {
    try {
      const localId = await localSpaceIdFor(space.id);
      if (localId != null) {
        const find = (items: SpaceItem[]): SpaceItem | null =>
          items.find((item) => item.id === localId) ?? null;
        const local = find(getSpacesValue()) ?? find(await loadSpaces());
        if (local) return local;
      }
    } catch {
      // Reported the same way as a missing copy.
    }
    toast({
      title: t("common.error"),
      description: t("common.unknownError"),
      variant: "destructive",
    });
    return null;
  }

  async function openTeamspace(space: WorkspaceSpace): Promise<void> {
    const local = await resolveLocalSpace(space);
    if (local) onOpenTeamspace?.(local.id);
  }

  async function openSettings(space: WorkspaceSpace): Promise<void> {
    const local = await resolveLocalSpace(space);
    if (!local) return;
    setSettingsSpaceId(local.id);
    setSettingsOpen(true);
  }

  async function requestDelete(
    space: WorkspaceSpace,
    actionsButton: HTMLElement | null
  ): Promise<void> {
    const local = await resolveLocalSpace(space);
    if (!local) return;
    deleteOriginRef.current = actionsButton;
    setDeleteTarget(local);
  }

  function closeDelete(): void {
    setDeleteTarget(null);
    const origin = deleteOriginRef.current;
    deleteOriginRef.current = null;
    // The menu item that started the delete is gone, so nothing hands focus back and it would drop
    // to the page; the frame lets the dialog finish closing first. A deleted row's button is gone
    // too, and focusing it does nothing.
    requestAnimationFrame(() => origin?.focus());
  }

  function setJoining(spaceId: string, joining: boolean): void {
    if (joining) joiningRef.current.add(spaceId);
    else joiningRef.current.delete(spaceId);
    setJoiningIds(new Set(joiningRef.current));
  }

  async function handleJoin(space: WorkspaceSpace): Promise<void> {
    if (joiningRef.current.has(space.id)) return;
    setJoining(space.id, true);
    const name = isolate(space.name);
    try {
      await joinSpace(space.id);
      toast({
        title: t("settingsPage.workspace.teamspaces.joined", { space: name }),
        actions: [
          {
            label: t("settingsPage.workspace.teamspaces.openTeamspace"),
            onClick: () => openTeamspace(space),
          },
        ],
      });
      // The row keeps reading Joining… until the list says the user is in, rather than
      // flashing Join again.
      await reload();
    } catch (error) {
      const failure = classifySpaceError(error);
      if (failure.kind === "notOpen") {
        toast({
          title: t("settingsPage.workspace.teamspaces.joinClosed", { space: name }),
          variant: "destructive",
        });
        await reload();
      } else if (failure.kind === "gone" || failure.kind === "archived") {
        // It was deleted meanwhile (a member is told it's archived; only outsiders get not found);
        // the list showing that is the answer.
        await reload();
      } else {
        toast({
          title: t("settingsPage.workspace.teamspaces.joinFailed", { space: name }),
          variant: "destructive",
        });
      }
    } finally {
      setJoining(space.id, false);
    }
  }

  const showHeaderCreate = canCreate && !(status === "ready" && spaces.length === 0);

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("settingsPage.workspace.teamspaces.title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground/80">
            {canCreate
              ? t("settingsPage.workspace.teamspaces.subtitleManage")
              : t("settingsPage.workspace.teamspaces.subtitleView")}
          </p>
        </div>
        {showHeaderCreate && (
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            {t("settingsPage.workspace.teamspaces.create")}
          </Button>
        )}
      </div>

      <TeamspacesTable
        status={status}
        spaces={spaces}
        canCreate={canCreate}
        currentUser={user}
        joiningIds={joiningIds}
        workspaceAdmins={workspaceAdmins}
        workspaceAdminsLoading={adminsLoading}
        onWorkspaceAdminsOpen={loadWorkspaceAdmins}
        onRetry={() => void reload()}
        onCreate={() => setCreateOpen(true)}
        onJoin={(space) => void handleJoin(space)}
        onOpen={(space) => void openTeamspace(space)}
        onSettings={(space) => void openSettings(space)}
        onDelete={(space, actionsButton) => void requestDelete(space, actionsButton)}
      />

      <CreateSpaceDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) void reload();
        }}
        initialWorkspaceId={workspace.id}
        revealOnCreate={false}
      />

      {settingsSpace && (
        <SpaceSettingsDialog
          space={settingsSpace}
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            // Its switches and description live on the server, not in the mirror.
            if (!open) void reload();
          }}
        />
      )}

      <DeleteSpaceDialog space={deleteTarget} onClose={closeDelete} />
    </>
  );
}
