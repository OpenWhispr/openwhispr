import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Loader2, Settings, Trash2, User, UserCircle } from "../icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useAuth } from "../../hooks/useAuth";
import { teamCan, workspaceCan } from "../../lib/capabilities";
import { classifyTeamError } from "../../lib/workspaceErrors";
import { renameTeam } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { TeamGlyph } from "../workspace/TeamGlyph";
import { SettingRow } from "../workspace/SettingRow";
import {
  INLINE_FIELD_CLASS,
  ROW_BUTTON_CLASS,
  TAB_TRIGGER_CLASS,
} from "../workspace/dialogButtons";
import DeleteTeamDialog from "./DeleteTeamDialog";
import LeaveTeamDialog from "./LeaveTeamDialog";
import TeamMembersPanel from "./TeamMembersPanel";
import TeamSpacesPanel from "./TeamSpacesPanel";
import { isolate } from "../../utils/bidiIsolate";
import type { Team, Workspace } from "../../types/electron";

const KEY = "settingsPage.workspace.teams";
const NAME_MAX_LENGTH = 80;

type TeamDialogTab = "general" | "members" | "spaces";

interface TeamSettingsDialogProps {
  team: Team;
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

  const [tab, setTab] = useState<TeamDialogTab>("general");
  const [wasOpen, setWasOpen] = useState(open);
  const [draftName, setDraftName] = useState(team.name);
  // The name the draft was seeded from or last saved as; null while closed.
  const [nameBaseline, setNameBaseline] = useState<string | null>(null);
  const [nameTaken, setNameTaken] = useState<string | null>(null);
  // The name a rename is sending right now. Until it's answered it counts as the saved name, so
  // Esc can't put back the name it is replacing.
  const [savingName, setSavingName] = useState<string | null>(null);
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
  // Set once the dialog is closing or gone, so an answer that lands after it can't be shown in
  // a field that is no longer there.
  const closing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    isOpen.current = open;
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  // Each opening starts on General, with nothing carried over from the last.
  if (open !== wasOpen) {
    setWasOpen(open);
    setTab("general");
    setNameTaken(null);
    refusedName.current = null;
    if (open) closing.current = false;
  }

  const commitName = async (): Promise<void> => {
    if (!canRename || nameBaseline === null) return;
    const name = draftName.trim();
    if (name === nameBaseline) return;
    if (!name) {
      setDraftName(nameBaseline);
      return;
    }
    if (name === refusedName.current) {
      // Still the refused name: the message stays with it.
      setNameTaken(name);
      return;
    }
    if (namesInFlight.current.has(name)) return;
    namesInFlight.current.add(name);
    setSavingName(name);
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
        if (closing.current || !mounted.current) {
          toast({
            title: t(`${KEY}.form.nameTaken`, { name: isolate(name) }),
            variant: "destructive",
          });
        } else {
          setNameTaken(name);
        }
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
      setSavingName((current) => (current === name ? null : current));
    }
  };

  const savedName = savingName ?? nameBaseline;
  const nameDirty = savedName !== null && draftName.trim() !== savedName;
  const revertName = (): void => {
    if (savedName !== null) setDraftName(savedName);
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
    closing.current = true;
    void commitName();
    onOpenChange(false);
  };

  // Reads the roster afresh before the confirm opens, whatever the row says: who else is an admin
  // changes while this dialog is open (the block sends people to the Members tab to fix exactly
  // that), and nothing reloads the row after a roster change. The user is the only admin when the
  // read shows one admin row and it is theirs; a workspace admin keeps access either way, so
  // they are never blocked. A failed read falls back to the row, then to the server's refusal.
  const startLeave = async (): Promise<void> => {
    if (checkingLeave || deleteOpen) return;
    setCheckingLeave(true);
    let facts = { soleAdmin: team.sole_admin, otherAdmins: true };
    try {
      const admins = (await TeamsService.listMembers(team.id)).filter(
        (member) => member.role === "admin"
      );
      facts = {
        soleAdmin: !isWorkspaceAdmin && admins.length === 1 && admins[0].user_id === userId,
        otherAdmins: admins.some((member) => member.user_id !== userId),
      };
    } catch {
      // Unknown: the row's answer and the default wording, and the server decides.
    }
    setCheckingLeave(false);
    if (!mounted.current || !isOpen.current) return;
    setLeaveFacts(facts);
    setLeaveOpen(true);
  };

  const general =
    canLeave || canDelete ? (
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-surface-1">
        {canLeave && (
          <SettingRow
            icon={User}
            title={t(`${KEY}.exit.leaveTitle`)}
            body={t(`${KEY}.exit.leaveBody`)}
          >
            <button
              type="button"
              onClick={() => void startLeave()}
              disabled={checkingLeave || deleteOpen}
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
              disabled={checkingLeave}
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
              <TeamGlyph emoji={team.emoji} name={team.name} />
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

          <Tabs value={tab} onValueChange={(next) => setTab(next as TeamDialogTab)}>
            <TabsList className="h-7 p-0.5 rounded-[7px]">
              <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                <Settings className="size-3" aria-hidden="true" />
                {t(`${KEY}.dialog.tabGeneral`)}
              </TabsTrigger>
              <TabsTrigger value="members" className={TAB_TRIGGER_CLASS}>
                <UserCircle className="size-3" aria-hidden="true" />
                {t(`${KEY}.dialog.tabMembers`)}
              </TabsTrigger>
              <TabsTrigger value="spaces" className={TAB_TRIGGER_CLASS}>
                <Building2 className="size-3" aria-hidden="true" />
                {t(`${KEY}.dialog.tabSpaces`)}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="mt-4">
              {general}
            </TabsContent>
            <TabsContent value="members" className="mt-4">
              <TeamMembersPanel
                team={team}
                workspace={workspace}
                managed={managed}
                onChanged={onChanged}
                onGone={onGone}
              />
            </TabsContent>
            <TabsContent value="spaces" className="mt-4">
              <TeamSpacesPanel
                team={team}
                workspace={workspace}
                onChanged={onChanged}
                onGone={onGone}
              />
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
          onGone={onGone}
        />
      )}

      {deleteOpen && (
        <DeleteTeamDialog team={team} onClose={() => setDeleteOpen(false)} onDeleted={onGone} />
      )}
    </>
  );
}
