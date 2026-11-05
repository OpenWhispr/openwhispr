import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  LogIn,
  LogOut,
  Settings,
  Trash2,
  UserCircle,
  UserPlus,
  type IconComponent,
} from "../icons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Popover, PopoverTrigger } from "../ui/popover";
import { EmojiPickerContent } from "../ui/EmojiPicker";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useAuth } from "../../hooks/useAuth";
import { useWorkspaceSpaces } from "../../hooks/useWorkspaceSpaces";
import { spaceCan, workspaceCan } from "../../lib/capabilities";
import { localMutationErrorKey } from "../../lib/localMutationError";
import { renameSpace, setSpaceAccessFlags } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import DeleteSpaceDialog from "./DeleteSpaceDialog";
import { LeaveSpaceDialog } from "./LeaveSpaceDialog";
import SpaceMembersPanel from "./SpaceMembersPanel";
import { TileGlyph } from "./SpaceNameField";
import { isolate } from "../../utils/bidiIsolate";
import type { SpaceItem } from "../../types/electron";

const TAB_TRIGGER_CLASS = "h-6 gap-1.5 px-2.5 text-xs rounded-[5px]";
const DESCRIPTION_MAX_LENGTH = 280;
const NAME_MAX_LENGTH = 80;

// The header's name and description read as plain text until focused, as in the frame, so an
// admin's field only shows itself when it's in use. The padding is pulled back out with a
// negative margin, so the text lines up with the tile above it.
const INLINE_FIELD_CLASS =
  "input-inline -mx-1.5 block w-[calc(100%+0.75rem)] min-w-0 resize-none rounded-md bg-transparent px-1.5 outline-none " +
  "transition-colors hover:bg-foreground/5 focus:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/15";

const ROW_BUTTON_CLASS =
  "inline-flex h-7 shrink-0 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";

export type SpaceSettingsTab = "general" | "members";

type AccessFlag = "is_default" | "is_open";

interface SpaceSettingsDialogProps {
  space: SpaceItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SpaceSettingsTab;
  /** The dialog has no trigger element for Radix to return focus to; hosts pick the target. */
  onCloseAutoFocus?: (event: Event) => void;
}

// Everything about one teamspace: its name, emoji and description, whether it's the default or
// open, who has access, leaving and deleting. Edits save as they happen: the emoji on pick, the
// name and description on blur, Enter, or close, and a switch when it's flipped.
export default function SpaceSettingsDialog({
  space,
  open,
  onOpenChange,
  initialTab = "general",
  onCloseAutoFocus,
}: SpaceSettingsDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === space.workspace_id));
  const cloudSpaceId = space.cloud_space_id;
  // Local-only spaces stay fully manageable; cloud spaces follow space and
  // workspace capabilities. Cosmetic — the server enforces.
  const canManage =
    !cloudSpaceId ||
    spaceCan(space, "manage_settings") ||
    workspaceCan(workspace, "manage_settings");
  // Workspace admins reach every space whatever they hold, so they have
  // nothing to leave. The space role fallback has no workspace role to check
  // that against, so the check stays here.
  const isWorkspaceAdmin = workspaceCan(workspace, "manage_settings");
  const canLeave =
    Boolean(cloudSpaceId) && !isWorkspaceAdmin && spaceCan(space, "leave") && Boolean(user?.id);

  // The flags and description live in the directory, not the local mirror, so the dialog asks the
  // server for them, and a local-only space has nothing to ask about.
  const directory = useWorkspaceSpaces(space.workspace_id, open && Boolean(cloudSpaceId));
  const [wasOpen, setWasOpen] = useState(open);
  // Hosts keep this dialog mounted and the hook keeps its list, so the list on hand at an opening
  // is the last opening's. Its row is believed only once a read has landed since this one began.
  const [loadsAtOpen, setLoadsAtOpen] = useState(directory.loads);
  const loadedSinceOpen = directory.loads > loadsAtOpen;
  const row = loadedSinceOpen
    ? directory.spaces.find((candidate) => candidate.id === cloudSpaceId)
    : undefined;
  // Failed only when there is nothing to believe: still reading is not failing.
  const directoryFailed =
    !row && (directory.status === "failed" || directory.stale || loadedSinceOpen);

  const [tab, setTab] = useState<SpaceSettingsTab>(initialTab);
  const [draftName, setDraftName] = useState(space.name);
  // The name the draft was seeded from or last saved as; null while closed.
  const [nameBaseline, setNameBaseline] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState("");
  // The directory's description once it has loaded, then what was last saved; null until then.
  const [descriptionBaseline, setDescriptionBaseline] = useState<string | null>(null);
  // A switch the user flipped shows what they asked for from the moment they press it, over the
  // directory's copy, which only catches up when the dialog reads it again.
  const [flagChoices, setFlagChoices] = useState<Partial<Record<AccessFlag, boolean>>>({});
  const [savingFlags, setSavingFlags] = useState<ReadonlySet<AccessFlag>>(() => new Set());
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [checkingLeave, setCheckingLeave] = useState(false);
  // What Leave's dialog is told, read when it's pressed: whether the user is the only admin, and
  // whether anyone else is. Unknown (undefined) leaves the answer to the server.
  const [leaveFacts, setLeaveFacts] = useState<{
    soleAdmin: boolean | undefined;
    otherAdmins: boolean;
  }>({ soleAdmin: undefined, otherAdmins: false });
  const [deleteTarget, setDeleteTarget] = useState<SpaceItem | null>(null);

  // Saves run one at a time, each building its payload from the latest row the
  // store has handed us rather than a snapshot another in-flight save may roll back.
  const saveChain = useRef(Promise.resolve());
  // The texts being saved right now, so Enter and the blur that follows it are one edit.
  const namesInFlight = useRef(new Set<string>());
  // A name the server just refused, which closing or leaving the field shouldn't send again.
  const refusedName = useRef<string | null>(null);
  const descriptionsInFlight = useRef(new Set<string>());
  const latestSpace = useRef(space);
  const isOpen = useRef(open);
  useEffect(() => {
    latestSpace.current = space;
    isOpen.current = open;
  }, [space, open]);

  // Seed on open, and follow renames made elsewhere until the user edits.
  if (
    open &&
    (nameBaseline === null || (draftName === nameBaseline && space.name !== nameBaseline))
  ) {
    setNameBaseline(space.name);
    setDraftName(space.name);
  } else if (!open && nameBaseline !== null) {
    setNameBaseline(null);
  }
  // The description has no copy in the mirror to follow, so it's taken once per opening, when the
  // directory first has it. Until then the field is read-only, and a directory that can't be read
  // leaves it out rather than showing an empty box that stands for a description it can't see.
  if (open && descriptionBaseline === null && row) {
    setDescriptionBaseline(row.description ?? "");
    setDraftDescription(row.description ?? "");
  } else if (!open && descriptionBaseline !== null) {
    setDescriptionBaseline(null);
    setDraftDescription("");
  }
  // Each opening starts on the tab it was asked for, with nothing carried over from the last.
  if (open !== wasOpen) {
    setWasOpen(open);
    setLoadsAtOpen(directory.loads);
    setTab(initialTab);
    setFlagChoices({});
  }

  const save = (
    updates: { name?: string; emoji?: string | null; description?: string | null },
    failureTitle: string
  ): Promise<"saved" | "nameTaken" | "failed"> => {
    const run = saveChain.current.then(async () => {
      const latest = latestSpace.current;
      const result = await renameSpace(latest, {
        name: latest.name,
        emoji: latest.emoji ?? null,
        ...updates,
      });
      if (result.success) return "saved";
      const nameTaken = result.failure?.kind === "nameTaken";
      toast({
        title: failureTitle,
        description: nameTaken
          ? t("settingsPage.workspace.teamspaces.form.nameTaken", {
              name: isolate(updates.name ?? latest.name),
            })
          : t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
      return nameTaken ? "nameTaken" : "failed";
    });
    saveChain.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const commitName = async (): Promise<void> => {
    if (!canManage || nameBaseline === null) return;
    const name = draftName.trim();
    if (name === nameBaseline) return;
    if (!name) {
      setDraftName(nameBaseline);
      return;
    }
    if (namesInFlight.current.has(name) || name === refusedName.current) return;
    namesInFlight.current.add(name);
    try {
      const saved = await save({ name }, t("notes.spaces.couldNotRename"));
      if (saved === "saved") setNameBaseline(name);
      // A taken name stays in the field, so the user can change it rather than type it again.
      else if (saved === "failed") setDraftName(nameBaseline);
      else refusedName.current = name;
    } finally {
      namesInFlight.current.delete(name);
    }
  };

  const commitDescription = async (): Promise<void> => {
    if (!canManage || descriptionBaseline === null) return;
    const description = draftDescription.trim();
    if (description === descriptionBaseline) return;
    if (descriptionsInFlight.current.has(description)) return;
    descriptionsInFlight.current.add(description);
    try {
      if (
        (await save(
          { description: description || null },
          t("settingsPage.workspace.teamspaces.settings.flagSaveFailed")
        )) === "saved"
      ) {
        setDescriptionBaseline(description);
        setDraftDescription(description);
        void directory.reload();
      } else {
        setDraftDescription(descriptionBaseline);
      }
    } finally {
      descriptionsInFlight.current.delete(description);
    }
  };

  const changeEmoji = (emoji: string | null): void => {
    if (emoji !== (space.emoji ?? null)) {
      void save({ emoji }, t("notes.spaces.couldNotChangeEmoji"));
    }
  };

  const close = (): void => {
    void commitName();
    void commitDescription();
    refusedName.current = null;
    onOpenChange(false);
  };

  const flagValue = (flag: AccessFlag): boolean => flagChoices[flag] ?? row?.[flag] === true;

  const changeFlag = async (flag: AccessFlag, next: boolean): Promise<void> => {
    if (!cloudSpaceId) return;
    const previous = flagValue(flag);
    setFlagChoices((choices) => ({ ...choices, [flag]: next }));
    setSavingFlags((saving) => new Set(saving).add(flag));
    try {
      try {
        await setSpaceAccessFlags(
          cloudSpaceId,
          flag === "is_default" ? { is_default: next } : { is_open: next }
        );
      } catch {
        setFlagChoices((choices) => ({ ...choices, [flag]: previous }));
        toast({
          title: t("settingsPage.workspace.teamspaces.settings.flagSaveFailed"),
          variant: "destructive",
        });
      }
      // Read the server's value whichever way the save went: an answer that was lost may still
      // have landed. Once it's in, the row carries the switch again, not the choice.
      if (await directory.reload()) setFlagChoices((choices) => withoutChoice(choices, flag));
    } finally {
      setSavingFlags((saving) => {
        const remaining = new Set(saving);
        remaining.delete(flag);
        return remaining;
      });
    }
  };

  // Reads the directory afresh before the confirm opens: who else is an admin changes while this
  // dialog is open (the block sends people to the Members tab to fix exactly that), and the list
  // it holds is from before. A failed read leaves the answer to the server.
  const startLeave = async (): Promise<void> => {
    setCheckingLeave(true);
    const fresh = await directory.reload();
    setCheckingLeave(false);
    if (!isOpen.current) return;
    const freshRow = fresh?.find((candidate) => candidate.id === cloudSpaceId);
    setLeaveFacts({
      soleAdmin: freshRow?.sole_admin,
      otherAdmins: (freshRow?.admins ?? []).some((contact) => contact.user_id !== user?.id),
    });
    setLeaveOpen(true);
  };

  const flagsReady = Boolean(row);
  const deleteLocked = Boolean(cloudSpaceId) && flagValue("is_default") && !isWorkspaceAdmin;
  const flagDisabled = (flag: AccessFlag, allowed: boolean): boolean =>
    !flagsReady || !allowed || savingFlags.has(flag);

  const general = (
    <div className="space-y-3">
      {cloudSpaceId && directoryFailed && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-1 px-3.5 py-2.5 text-xs text-muted-foreground">
          <p role="alert">{t("settingsPage.workspace.teamspaces.settings.flagsFailed")}</p>
          <button
            type="button"
            onClick={() => void directory.reload()}
            className={cn(ROW_BUTTON_CLASS, "bg-surface-3 text-foreground hover:bg-surface-raised")}
          >
            {t("settingsPage.workspace.teamspaces.retry")}
          </button>
        </div>
      )}

      <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-surface-1">
        {cloudSpaceId && (
          <>
            <SettingRow
              icon={UserPlus}
              title={t("settingsPage.workspace.teamspaces.form.defaultTitle")}
              body={t("settingsPage.workspace.teamspaces.form.defaultBody")}
              hint={
                flagsReady && !workspaceCan(workspace, "manage_settings")
                  ? t("settingsPage.workspace.teamspaces.settings.defaultAdminOnly")
                  : undefined
              }
            >
              <Toggle
                checked={flagValue("is_default")}
                onChange={(next) => void changeFlag("is_default", next)}
                disabled={flagDisabled("is_default", workspaceCan(workspace, "manage_settings"))}
                ariaLabel={t("settingsPage.workspace.teamspaces.form.defaultTitle")}
              />
            </SettingRow>
            <SettingRow
              icon={LogIn}
              title={t("settingsPage.workspace.teamspaces.form.openTitle")}
              body={t("settingsPage.workspace.teamspaces.form.openBody")}
            >
              <Toggle
                checked={flagValue("is_open")}
                onChange={(next) => void changeFlag("is_open", next)}
                disabled={flagDisabled("is_open", canManage)}
                ariaLabel={t("settingsPage.workspace.teamspaces.form.openTitle")}
              />
            </SettingRow>
          </>
        )}

        {canLeave && (
          <SettingRow
            icon={LogOut}
            title={t("settingsPage.workspace.teamspaces.settings.leaveTitle")}
            body={t("settingsPage.workspace.teamspaces.settings.leaveBody")}
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
              {t("settingsPage.workspace.teamspaces.settings.leaveAction")}
            </button>
          </SettingRow>
        )}

        {canManage && (
          <SettingRow
            icon={Trash2}
            title={t("settingsPage.workspace.teamspaces.settings.deleteTitle")}
            body={
              cloudSpaceId
                ? t("settingsPage.workspace.teamspaces.settings.deleteBody")
                : t("notes.spaces.deleteHintLocal")
            }
            hint={
              deleteLocked
                ? t("settingsPage.workspace.teamspaces.settings.deleteDefaultAdminOnly")
                : undefined
            }
          >
            <button
              type="button"
              disabled={deleteLocked}
              onClick={() => {
                // A local teamspace asks for its name in a dialog of its own, so this one steps
                // aside first. A cloud one asks over this dialog, as the frames show, and a
                // delete that goes through closes both.
                if (!cloudSpaceId) close();
                setDeleteTarget(space);
              }}
              className={cn(
                ROW_BUTTON_CLASS,
                "bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {t("settingsPage.workspace.teamspaces.settings.deleteAction")}
            </button>
          </SettingRow>
        )}
      </div>
    </div>
  );

  const description = row?.description ?? null;
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
        <DialogContent
          className="max-h-[85vh] max-w-md gap-5 overflow-y-auto rounded-[28px] p-5"
          onCloseAutoFocus={(event) => {
            // Handing off to the delete confirm: leave focus in its input
            // instead of returning it to the host.
            if (deleteTarget) event.preventDefault();
            else onCloseAutoFocus?.(event);
          }}
        >
          <div className="flex flex-col items-start gap-3 pe-8">
            <HeaderTile
              emoji={space.emoji}
              name={space.name}
              editable={canManage}
              onEmojiChange={changeEmoji}
            />
            <div className="w-full min-w-0 space-y-1">
              {canManage ? (
                <>
                  <DialogTitle className="sr-only">{space.name}</DialogTitle>
                  <input
                    dir="auto"
                    type="text"
                    value={draftName}
                    maxLength={NAME_MAX_LENGTH}
                    aria-label={t("notes.spaces.nameAndIconLabel")}
                    onChange={(event) => setDraftName(event.target.value)}
                    onBlur={() => void commitName()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing)
                        void commitName();
                    }}
                    className={cn(INLINE_FIELD_CLASS, "h-8 text-lg font-medium text-foreground")}
                  />
                  {cloudSpaceId && !directoryFailed && (
                    <textarea
                      dir="auto"
                      rows={2}
                      value={draftDescription}
                      maxLength={DESCRIPTION_MAX_LENGTH}
                      readOnly={descriptionBaseline === null}
                      aria-label={t("settingsPage.workspace.teamspaces.form.descriptionLabel")}
                      placeholder={t(
                        "settingsPage.workspace.teamspaces.form.descriptionPlaceholder"
                      )}
                      onChange={(event) => setDraftDescription(event.target.value)}
                      onBlur={() => void commitDescription()}
                      onKeyDown={(event) => {
                        // A description is a line or two of prose, so Enter saves it.
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          void commitDescription();
                        }
                      }}
                      className={cn(
                        INLINE_FIELD_CLASS,
                        "max-h-28 overflow-y-auto py-0.5 text-sm text-muted-foreground [field-sizing:content]"
                      )}
                    />
                  )}
                </>
              ) : (
                <>
                  <DialogTitle
                    dir="auto"
                    className="text-lg font-medium leading-snug tracking-normal"
                  >
                    {space.name}
                  </DialogTitle>
                  {description && (
                    <DialogDescription dir="auto" className="text-sm">
                      {description}
                    </DialogDescription>
                  )}
                </>
              )}
            </div>
          </div>

          {cloudSpaceId ? (
            <Tabs value={tab} onValueChange={(next) => setTab(next as SpaceSettingsTab)}>
              <TabsList className="h-7 p-0.5 rounded-[7px]">
                <TabsTrigger value="general" className={TAB_TRIGGER_CLASS}>
                  <Settings className="size-3" aria-hidden="true" />
                  {t("settingsPage.workspace.tab.general")}
                </TabsTrigger>
                <TabsTrigger value="members" className={TAB_TRIGGER_CLASS}>
                  <UserCircle className="size-3" aria-hidden="true" />
                  {t("settingsPage.workspace.tab.members")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="mt-4">
                {general}
              </TabsContent>
              <TabsContent value="members" className="mt-4">
                <SpaceMembersPanel space={space} onLeft={() => onOpenChange(false)} />
              </TabsContent>
            </Tabs>
          ) : (
            general
          )}
        </DialogContent>
      </Dialog>

      {canLeave && user?.id && (
        <LeaveSpaceDialog
          space={space}
          userId={user.id}
          workspaceName={workspace?.name ?? ""}
          open={leaveOpen}
          onOpenChange={setLeaveOpen}
          soleAdmin={leaveFacts.soleAdmin}
          otherAdmins={leaveFacts.otherAdmins}
          onManageMembers={() => setTab("members")}
          onLeft={() => onOpenChange(false)}
        />
      )}

      <DeleteSpaceDialog
        space={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => onOpenChange(false)}
      />
    </>
  );
}

function withoutChoice(
  choices: Partial<Record<AccessFlag, boolean>>,
  flag: AccessFlag
): Partial<Record<AccessFlag, boolean>> {
  const rest = { ...choices };
  delete rest[flag];
  return rest;
}

interface HeaderTileProps {
  emoji: string | null;
  name: string;
  editable: boolean;
  onEmojiChange: (emoji: string | null) => void;
}

// The teamspace's tile above its name. For someone who can manage it, it opens the emoji picker.
function HeaderTile({ emoji, name, editable, onEmojiChange }: HeaderTileProps): ReactElement {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const tileClass =
    "flex size-[42px] shrink-0 items-center justify-center rounded-full bg-surface-3";

  if (!editable) {
    return (
      <span className={tileClass} aria-hidden="true">
        <TileGlyph emoji={emoji} name={name} />
      </span>
    );
  }
  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("notes.spaces.changeEmoji")}
          title={t("notes.spaces.changeEmoji")}
          className={cn(
            tileClass,
            "outline-none transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-primary/20 data-[state=open]:bg-surface-raised"
          )}
        >
          <TileGlyph emoji={emoji} name={name} />
        </button>
      </PopoverTrigger>
      <EmojiPickerContent
        value={emoji}
        onSelect={(next) => {
          onEmojiChange(next);
          setPickerOpen(false);
        }}
      />
    </Popover>
  );
}

interface SettingRowProps {
  icon: IconComponent;
  title: string;
  body: string;
  /** A reason the control can't be used, under the body. */
  hint?: string;
  children: ReactNode;
}

// One line of the General panel: what it is on the left, the control that changes it on the right.
function SettingRow({ icon: Icon, title, body, hint, children }: SettingRowProps): ReactElement {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </p>
        <p className="mt-0.5 ps-[22px] text-xs text-muted-foreground">{body}</p>
        {hint && <p className="mt-0.5 ps-[22px] text-xs text-muted-foreground/70">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
