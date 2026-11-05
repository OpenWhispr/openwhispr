import { useEffect, useRef, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2, LogOut, Settings, Trash2, UserCircle } from "../icons";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useAuth } from "../../hooks/useAuth";
import { useDialogs } from "../../hooks/useDialogs";
import { teamCan, workspaceCan } from "../../lib/capabilities";
import { rosterFor } from "../../lib/peopleRoster";
import { classifyTeamError } from "../../lib/workspaceErrors";
import { renameTeam } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import InviteTeammateDialog from "../InviteTeammateDialog";
import TeamRosterSection from "../TeamRosterSection";
import { TileGlyph } from "../notes/SpaceNameField";
import { SettingRow } from "../workspace/SettingRow";
import {
  INLINE_FIELD_CLASS,
  ROW_BUTTON_CLASS,
  TAB_TRIGGER_CLASS,
} from "../workspace/dialogButtons";
import DeleteTeamDialog from "./DeleteTeamDialog";
import LeaveTeamDialog from "./LeaveTeamDialog";
import { isolate } from "../../utils/bidiIsolate";
import type { Team, TeamMember, Workspace } from "../../types/electron";

const KEY = "settingsPage.workspace.teams";
const NAME_MAX_LENGTH = 80;

export type TeamDialogTab = "general" | "members" | "spaces";

interface TeamSettingsDialogProps {
  team: Team;
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: TeamDialogTab;
  /** A write changed something the table shows. */
  onChanged: () => void;
  /** The team is gone for this user: deleted, left or removed. */
  onGone: () => void;
}

// Everything about one team: its name, who is in it, leaving and deleting. The name saves as it
// is edited (on blur or Enter); a directory-managed team reads as text, whatever the viewer holds.
export default function TeamSettingsDialog({
  team,
  workspace,
  open,
  onOpenChange,
  initialTab = "general",
  onChanged,
  onGone,
}: TeamSettingsDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id;

  // A directory-managed team is read-only whatever the capabilities say, so an API that omits
  // them can't make it editable.
  const managed = team.directory_synced === true;
  const canRename = !managed && teamCan(team, workspace, "manage_settings");
  const canDelete = canRename;
  const canLeave = !managed && Boolean(userId) && teamCan(team, workspace, "leave");
  // Workspace admins reach every team whatever they hold, so leaving doesn't end their access
  // and they stay in the dialog afterwards.
  const isWorkspaceAdmin = workspaceCan(workspace, "manage_teams");

  const [tab, setTab] = useState<TeamDialogTab>(initialTab);
  const [wasOpen, setWasOpen] = useState(open);
  const [draftName, setDraftName] = useState(team.name);
  // The name the draft was seeded from or last saved as; null while closed.
  const [nameBaseline, setNameBaseline] = useState<string | null>(null);
  const [nameTaken, setNameTaken] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [checkingLeave, setCheckingLeave] = useState(false);
  const [leaveFacts, setLeaveFacts] = useState<{
    soleAdmin: boolean | undefined;
    otherAdmins: boolean;
  }>({
    soleAdmin: undefined,
    otherAdmins: true,
  });
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The texts being saved right now, so Enter and the blur that follows it are one edit.
  const namesInFlight = useRef(new Set<string>());
  // A name the server just refused, which closing or leaving the field shouldn't send again.
  const refusedName = useRef<string | null>(null);
  const isOpen = useRef(open);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  // Radix keeps the Esc handler it first saw, so the current one is read through a ref.
  const escapeHandler = useRef<(event: KeyboardEvent) => void>(() => {});

  // The name the row had when it was last looked at, so only a rename made elsewhere moves the
  // field, never the saved name it is still waiting on a reload for.
  const [seenTeamName, setSeenTeamName] = useState(team.name);

  // Seed on open, and follow renames made elsewhere until the user edits.
  if (open && nameBaseline === null) {
    setNameBaseline(team.name);
    setDraftName(team.name);
    setSeenTeamName(team.name);
  } else if (!open && nameBaseline !== null) {
    setNameBaseline(null);
  } else if (team.name !== seenTeamName) {
    setSeenTeamName(team.name);
    if (draftName === nameBaseline) {
      setNameBaseline(team.name);
      setDraftName(team.name);
    }
  }
  // Each opening starts on the tab it was asked for, with nothing carried over from the last.
  if (open !== wasOpen) {
    setWasOpen(open);
    setTab(initialTab);
    setNameTaken(null);
    refusedName.current = null;
  }

  const commitName = async (): Promise<void> => {
    if (!canRename || nameBaseline === null) return;
    const name = draftName.trim();
    if (name === nameBaseline) return;
    if (!name) {
      setDraftName(nameBaseline);
      return;
    }
    if (namesInFlight.current.has(name) || name === refusedName.current) return;
    namesInFlight.current.add(name);
    try {
      await renameTeam(team.id, name);
      setNameBaseline(name);
      setNameTaken(null);
      onChanged();
    } catch (error) {
      const failure = classifyTeamError(error);
      if (failure.kind === "nameTaken") {
        // Stays in the field, so the user can change it rather than type it again.
        refusedName.current = name;
        setNameTaken(name);
      } else if (failure.kind === "gone") {
        toast({
          title: t(`${KEY}.members.gone`, { team: isolate(team.name) }),
          variant: "destructive",
        });
        onGone();
      } else {
        setDraftName(nameBaseline);
        toast({
          title: t(`${KEY}.dialog.renameFailed`, { team: isolate(team.name) }),
          variant: "destructive",
        });
      }
    } finally {
      namesInFlight.current.delete(name);
    }
  };

  const nameDirty = nameBaseline !== null && draftName.trim() !== nameBaseline;
  const revertName = (): void => {
    if (nameBaseline !== null) setDraftName(nameBaseline);
    setNameTaken(null);
    refusedName.current = null;
  };
  useEffect(() => {
    // Esc first puts back the saved name, then closes.
    escapeHandler.current = (event) => {
      if (!nameDirty) return;
      event.preventDefault();
      revertName();
    };
  });

  const close = (): void => {
    void commitName();
    onOpenChange(false);
  };

  // Reads the roster afresh before the confirm opens: who else is an admin changes while this
  // dialog is open (the block sends people to the Members tab to fix exactly that). Only a
  // workspace admin's answer depends on it, since anyone else who is the only admin is blocked
  // by the row. A failed read leaves the answer to the server.
  const startLeave = async (): Promise<void> => {
    let otherAdmins = true;
    if (isWorkspaceAdmin) {
      setCheckingLeave(true);
      try {
        const members = await TeamsService.listMembers(team.id);
        otherAdmins = members.some(
          (member) => member.role === "admin" && member.user_id !== userId
        );
      } catch {
        // Unknown: the default wording, and the server decides.
      }
      setCheckingLeave(false);
      if (!isOpen.current) return;
    }
    setLeaveFacts({ soleAdmin: team.sole_admin, otherAdmins });
    setLeaveOpen(true);
  };

  const general =
    canLeave || canDelete ? (
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-surface-1">
        {canLeave && (
          <SettingRow
            icon={LogOut}
            title={t(`${KEY}.exit.leaveTitle`)}
            body={t(`${KEY}.exit.leaveBody`)}
          >
            <button
              type="button"
              onClick={() => void startLeave()}
              disabled={checkingLeave}
              aria-busy={checkingLeave}
              className={cn(
                ROW_BUTTON_CLASS,
                "gap-1.5 bg-surface-3 text-foreground hover:bg-surface-raised"
              )}
            >
              {checkingLeave && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
              {t(`${KEY}.exit.leaveAction`)}
            </button>
          </SettingRow>
        )}
        {canDelete && (
          <SettingRow
            icon={Trash2}
            title={t(`${KEY}.exit.deleteTitle`)}
            body={t(`${KEY}.exit.deleteBody`)}
          >
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className={cn(
                ROW_BUTTON_CLASS,
                "bg-destructive/10 text-destructive hover:bg-destructive/20"
              )}
            >
              {t(`${KEY}.exit.deleteAction`)}
            </button>
          </SettingRow>
        )}
      </div>
    ) : null;

  // Teamspaces joins the tabs once its panel lands.
  const visibleTab = tab === "spaces" ? "general" : tab;
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="max-h-[85vh] max-w-md gap-5 overflow-y-auto rounded-[28px] p-5"
          onEscapeKeyDown={(event) => escapeHandler.current(event)}
        >
          <div className="flex flex-col items-start gap-3 pe-8">
            <span
              className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-surface-3"
              aria-hidden="true"
            >
              <TileGlyph emoji={team.emoji ?? null} name={team.name} />
            </span>
            <div className="w-full min-w-0 space-y-1">
              {canRename ? (
                <>
                  <DialogTitle className="sr-only">{team.name}</DialogTitle>
                  <input
                    dir="auto"
                    type="text"
                    value={draftName}
                    maxLength={NAME_MAX_LENGTH}
                    aria-label={t(`${KEY}.dialog.nameLabel`)}
                    aria-invalid={nameTaken !== null}
                    onChange={(event) => {
                      setDraftName(event.target.value);
                      setNameTaken(null);
                    }}
                    onBlur={() => void commitName()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        void commitName();
                      }
                    }}
                    className={cn(INLINE_FIELD_CLASS, "h-8 text-lg font-medium text-foreground")}
                  />
                  {nameTaken !== null && (
                    <p role="alert" className="text-xs text-destructive">
                      {t(`${KEY}.form.nameTaken`, { name: isolate(nameTaken) })}
                    </p>
                  )}
                </>
              ) : (
                <DialogTitle
                  dir="auto"
                  className="text-lg font-medium leading-snug tracking-normal"
                >
                  {team.name}
                </DialogTitle>
              )}
              {managed && (
                <DialogDescription className="text-sm">
                  {t(`${KEY}.managedByDirectory`)}
                </DialogDescription>
              )}
            </div>
          </div>

          <Tabs value={visibleTab} onValueChange={(next) => setTab(next as TeamDialogTab)}>
            <TabsList className="h-7 p-0.5 rounded-[7px]">
              <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                <Settings className="size-3" aria-hidden="true" />
                {t(`${KEY}.dialog.tabGeneral`)}
              </TabsTrigger>
              <TabsTrigger value="members" className={TAB_TRIGGER_CLASS}>
                <UserCircle className="size-3" aria-hidden="true" />
                {t(`${KEY}.dialog.tabMembers`)}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="mt-4">
              {general}
            </TabsContent>
            <TabsContent value="members" className="mt-4">
              <RosterPanel team={team} workspace={workspace} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {canLeave && userId && (
        <LeaveTeamDialog
          team={team}
          userId={userId}
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
          soleAdmin={leaveFacts.soleAdmin}
          otherAdmins={leaveFacts.otherAdmins}
          onManageMembers={() => setTab("members")}
          onLeft={isWorkspaceAdmin ? onChanged : onGone}
        />
      )}

      {deleteOpen && (
        <DeleteTeamDialog
          team={team}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => {
            onOpenChange(false);
            onGone();
          }}
        />
      )}
    </>
  );
}

interface RosterPanelProps {
  team: Team;
  workspace: Workspace;
}

// The roster as it was before the Members tab was rebuilt: the old section with its remove
// confirm and the invite for an unknown address.
function RosterPanel({ team, workspace }: RosterPanelProps): ReactElement {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const { members: roster, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({ members: rosterFor(s, workspace.id), refreshMembers: s.refreshMembers }))
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined);

  useEffect(() => {
    void refreshMembers(workspace.id).catch(() => {});
  }, [workspace.id, refreshMembers]);

  const confirmRemoveMember = (member: TeamMember, onConfirm: () => void): void => {
    showConfirmDialog({
      title: t(`${KEY}.members.removeConfirm`, {
        name: member.name || member.email,
        team: team.name,
      }),
      description: t("notes.spaces.members.removeConfirmDescription"),
      confirmText: t("notes.spaces.members.remove"),
      variant: "destructive",
      onConfirm,
    });
  };

  return (
    <>
      <TeamRosterSection
        teamId={team.id}
        teamName={team.name}
        canManage={teamCan(team, workspace, "manage_members")}
        workspaceMembers={roster}
        currentUserId={user?.id}
        // Workspace invites are 403'd without manage_members.
        onInvite={
          workspaceCan(workspace, "manage_members")
            ? (email) => {
                setInviteEmail(email);
                setInviteOpen(true);
              }
            : undefined
        }
        removeConfirm={confirmRemoveMember}
      />

      <InviteTeammateDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        teamIds={[team.id]}
        initialEmail={inviteEmail}
      />

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(next) => !next && hideConfirmDialog()}
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
