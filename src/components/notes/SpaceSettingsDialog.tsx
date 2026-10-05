import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, LogOut, Trash2 } from "../icons";
import { Button } from "../ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useToast } from "../ui/useToast";
import { useAuth } from "../../hooks/useAuth";
import { useDialogs } from "../../hooks/useDialogs";
import {
  canLeaveSpace,
  canManageSpace,
  canManageWorkspace,
  teamsUserCanLeave,
} from "../../lib/spacePermissions";
import { formatList } from "../../lib/formatList";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { leaveSpace, leaveTeam, renameSpace } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import DeleteSpaceDialog from "./DeleteSpaceDialog";
import SpaceMembersPanel from "./SpaceMembersPanel";
import SpaceNameField from "./SpaceNameField";
import type { SpaceItem } from "../../types/electron";

const DANGER_BUTTON_CLASS =
  "w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive";
const TAB_TRIGGER_CLASS = "h-6 px-2.5 text-xs rounded-[5px]";

export type SpaceSettingsTab = "general" | "members";

interface SpaceSettingsDialogProps {
  space: SpaceItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SpaceSettingsTab;
  /** The dialog has no trigger element for Radix to return focus to; hosts pick the target. */
  onCloseAutoFocus?: (event: Event) => void;
}

// Everything about one team space: name and emoji, who has access, leaving
// and deleting. Edits save as they happen: the emoji on pick, the name on
// blur, Enter, or close.
export default function SpaceSettingsDialog({
  space,
  open,
  onOpenChange,
  initialTab = "general",
  onCloseAutoFocus,
}: SpaceSettingsDialogProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const workspaceRole = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === space.workspace_id)?.role ?? null
  );
  // Local-only spaces stay fully manageable; cloud spaces follow space and
  // workspace roles. Cosmetic — the server enforces.
  const canManage = !space.cloud_space_id || canManageSpace(space, workspaceRole);
  const isWorkspaceAdmin = canManageWorkspace(workspaceRole);

  const [draftName, setDraftName] = useState(space.name);
  // The name the draft was seeded from or last saved as; null while closed.
  const [baseline, setBaseline] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SpaceItem | null>(null);
  // Saves run one at a time, each building its payload from the latest row the
  // store has handed us rather than a snapshot another in-flight save may roll back.
  const saveChain = useRef(Promise.resolve());
  const latestSpace = useRef(space);
  useEffect(() => {
    latestSpace.current = space;
  }, [space]);
  // Select the name once per open, like a rename field. Not autoFocus: the
  // field remounts with the General tab, and re-selecting on each return
  // would pull focus out of the tab list.
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && canManage) nameInputRef.current?.select();
  }, [open, canManage]);

  // Seed on open, and follow renames made elsewhere until the user edits.
  if (open && (baseline === null || (draftName === baseline && space.name !== baseline))) {
    setBaseline(space.name);
    setDraftName(space.name);
  } else if (!open && baseline !== null) {
    setBaseline(null);
  }

  const save = (updates: { name?: string; emoji?: string | null }, failureKey: string) => {
    const run = saveChain.current.then(async () => {
      const latest = latestSpace.current;
      const result = await renameSpace(latest, {
        name: latest.name,
        emoji: latest.emoji ?? null,
        ...updates,
      });
      if (!result.success) {
        toast({
          title: t(failureKey),
          description: t(localMutationErrorKey(result.error)),
          variant: "destructive",
        });
      }
      return result.success;
    });
    saveChain.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const commitName = async () => {
    if (!canManage || baseline === null) return;
    const name = draftName.trim();
    if (name === baseline) return;
    if (!name) {
      setDraftName(baseline);
      return;
    }
    if (await save({ name }, "notes.spaces.couldNotRename")) setBaseline(name);
    else setDraftName(baseline);
  };

  const changeEmoji = (emoji: string | null) => {
    if (emoji !== (space.emoji ?? null)) void save({ emoji }, "notes.spaces.couldNotChangeEmoji");
  };

  const close = () => {
    void commitName();
    onOpenChange(false);
  };

  const leaveTeams = teamsUserCanLeave(space);
  const canLeave =
    Boolean(space.cloud_space_id) && !isWorkspaceAdmin && canLeaveSpace(space) && Boolean(user?.id);

  // A direct grant is dropped on its own and access through groups is left
  // where it is: groups are managed in the group. Leaving through groups is
  // offered only when they are the sole grant, with its own warning.
  const confirmLeave = () => {
    if (!canLeave || !user?.id) return;
    const userId = user.id;
    const direct = space.my_direct_role != null;
    const groupNames = (names: string[]) => formatList(i18n.language, names);
    const groups = groupNames(leaveTeams.map((team) => team.name));
    const description = !direct
      ? t("notes.spaces.leaveConfirmDescription", { teams: groups })
      : leaveTeams.length > 0
        ? t("notes.spaces.leaveKeepsGroupAccess", { groups })
        : t("notes.spaces.leaveDirectDescription");
    showConfirmDialog({
      title: t("notes.spaces.leaveConfirmTitle", { space: space.name }),
      description,
      confirmText: t("notes.spaces.leave"),
      variant: "destructive",
      onConfirm: async () => {
        setLeaving(true);
        try {
          if (direct) {
            const { still_via_teams } = await leaveSpace(space, userId);
            if (still_via_teams.length > 0) {
              toast({
                title: t("notes.spaces.stillViaGroups", {
                  space: space.name,
                  groups: groupNames(still_via_teams.map((team) => team.name)),
                }),
              });
              return;
            }
          } else {
            for (const team of leaveTeams) await leaveTeam(team.id, userId);
          }
          toast({ title: t("notes.spaces.left", { space: space.name }) });
          onOpenChange(false);
        } catch (err) {
          toast({
            title: t("notes.spaces.couldNotLeave"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setLeaving(false);
        }
      },
    });
  };

  const general = (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="space-settings-name" className="text-xs font-medium text-foreground/50">
          {t("notes.spaces.nameAndIconLabel")}
        </label>
        <SpaceNameField
          id="space-settings-name"
          name={draftName}
          emoji={space.emoji}
          readOnly={!canManage}
          inputRef={nameInputRef}
          onNameChange={setDraftName}
          onEmojiChange={changeEmoji}
          onBlur={() => void commitName()}
          onEnter={() => void commitName()}
        />
      </div>

      {canLeave && (
        <section className="space-y-2">
          <div className="space-y-0.5">
            <h3 className="text-sm font-medium text-foreground">{t("notes.spaces.leaveTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("notes.spaces.leaveDescription")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className={DANGER_BUTTON_CLASS}
            disabled={leaving}
            onClick={confirmLeave}
          >
            {leaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
            {t("notes.spaces.leave")}
          </Button>
        </section>
      )}

      {canManage && (
        <section className="space-y-2">
          <div className="space-y-0.5">
            <h3 className="text-sm font-medium text-foreground">{t("notes.spaces.deleteSpace")}</h3>
            <p className="text-xs text-muted-foreground">
              {t(
                space.cloud_space_id
                  ? "notes.spaces.deleteHintTeam"
                  : "notes.spaces.deleteHintLocal"
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className={DANGER_BUTTON_CLASS}
            onClick={() => {
              close();
              setDeleteTarget(space);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("notes.spaces.deleteSpace")}
          </Button>
        </section>
      )}
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="max-w-xl max-h-[80vh] overflow-y-auto p-6 gap-5"
          onCloseAutoFocus={(event) => {
            // Handing off to the delete confirm: leave focus in its input
            // instead of returning it to the host.
            if (deleteTarget) event.preventDefault();
            else onCloseAutoFocus?.(event);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("notes.spaces.settingsTitle")}</DialogTitle>
          </DialogHeader>

          {space.cloud_space_id ? (
            <Tabs defaultValue={initialTab}>
              <TabsList className="h-7 p-0.5 rounded-[7px]">
                <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                  {t("settingsPage.workspace.tab.general")}
                </TabsTrigger>
                <TabsTrigger value="members" className={TAB_TRIGGER_CLASS}>
                  {t("settingsPage.workspace.tab.members")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="mt-5">
                {general}
              </TabsContent>
              <TabsContent value="members" className="mt-5">
                <SpaceMembersPanel space={space} />
              </TabsContent>
            </Tabs>
          ) : (
            general
          )}
        </DialogContent>
      </Dialog>

      <DeleteSpaceDialog space={deleteTarget} onClose={() => setDeleteTarget(null)} />

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
