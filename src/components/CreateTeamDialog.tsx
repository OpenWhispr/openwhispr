import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Plus, Users } from "./icons";
import { cn } from "./lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useToast, type ToastProps } from "./ui/useToast";
import { WorkspaceErrorBar } from "./workspace/WorkspaceErrorBar";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "./workspace/dialogButtons";
import { SpacePeopleField } from "./notes/SpacePeopleField";
import { createTeam } from "../services/spaceActions";
import { inviteAfterCreate, inviteFollowUpToast } from "../lib/inviteAfterCreate";
import { serverRefusalMessage } from "../services/cloudApi";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuth } from "../hooks/useAuth";
import { workspaceCan } from "../lib/capabilities";
import { formatList } from "../lib/formatList";
import { MAX_INVITE_RECIPIENTS } from "../lib/inviteFlow";
import { rosterFor } from "../lib/peopleRoster";
import { memberRecipient, pickedSummary, type PickedRecipient } from "../lib/spacePeoplePicker";
import { classifyTeamError } from "../lib/workspaceErrors";
import { isolate } from "../utils/bidiIsolate";
import type { Team, Workspace, WorkspaceMember } from "../types/electron";

// A toast names this many people per list before it falls back to a count.
const NAMED_PER_LIST = 2;
const FORM_KEY = "settingsPage.workspace.teams.form";

const NO_TEAMS: Team[] = [];

type NameError = { kind: "required" } | { kind: "taken"; name: string };
type CreateFailure = { kind: "general" } | { kind: "refused"; message: string };

export interface CreateTeamDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** People already chosen, from the People selection. */
  initialPeople?: WorkspaceMember[];
  /** Fires once the team exists, before the form closes. */
  onCreated?: (team: Team, outcome: { memberCount: number }) => void | Promise<void>;
  /** The server refused on plan: the host closes this and opens the paywall. */
  onPlanRequired: () => void;
}

/** One-step team creation: name it, pick or invite its people, and nothing sends before Create. */
export default function CreateTeamDialog({
  workspace,
  open,
  onOpenChange,
  initialPeople,
  onCreated,
  onPlanRequired,
}: CreateTeamDialogProps): ReactElement {
  // A create under way can't be taken back, so Esc and an overlay click wait for its answer.
  const creatingRef = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && creatingRef.current) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        hideCloseButton
        className="max-h-[calc(100vh-32px)] w-[420px] max-w-[calc(100vw-32px)] grid-cols-1 items-stretch gap-6 overflow-y-auto rounded-[28px] p-5 sm:max-w-[420px]"
      >
        {/* Mounted only while open, so every opening starts from nothing. */}
        <CreateTeamForm
          workspace={workspace}
          initialPeople={initialPeople}
          onClose={() => onOpenChange(false)}
          onCreatingChange={(creating) => {
            creatingRef.current = creating;
          }}
          onCreated={onCreated}
          onPlanRequired={onPlanRequired}
        />
      </DialogContent>
    </Dialog>
  );
}

interface FormProps {
  workspace: Workspace;
  initialPeople?: WorkspaceMember[];
  onClose: () => void;
  onCreatingChange: (creating: boolean) => void;
  onCreated?: CreateTeamDialogProps["onCreated"];
  onPlanRequired: () => void;
}

function CreateTeamForm({
  workspace,
  initialPeople,
  onClose,
  onCreatingChange,
  onCreated,
  onPlanRequired,
}: FormProps): ReactElement {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { members, membersWorkspaceId, refreshMembers } = useWorkspaceStore(
    useShallow((state) => ({
      members: state.members,
      membersWorkspaceId: state.membersWorkspaceId,
      refreshMembers: state.refreshMembers,
    }))
  );
  const nameInputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<PickedRecipient[]>(() =>
    (initialPeople ?? []).filter((person) => person.user_id !== user?.id).map(memberRecipient)
  );
  const [nameError, setNameError] = useState<NameError | null>(null);
  const [failure, setFailure] = useState<CreateFailure | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [rosterFailed, setRosterFailed] = useState(false);
  // Where focus goes once a failed create hands the form back: a disabled button loses it.
  const [refocus, setRefocus] = useState<"name" | "primary" | null>(null);

  const loadRoster = useCallback(async (): Promise<void> => {
    setRosterFailed(false);
    setRosterLoaded(false);
    try {
      await refreshMembers(workspace.id);
      setRosterLoaded(true);
    } catch {
      setRosterFailed(true);
    }
  }, [refreshMembers, workspace.id]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    if (!refocus || isCreating) return;
    (refocus === "name" ? nameInputRef.current : primaryRef.current)?.focus();
    setRefocus(null);
  }, [refocus, isCreating]);

  const roster = rosterFor({ members, membersWorkspaceId }, workspace.id);
  // The creator becomes the team's admin on the server, so the field never offers them.
  const hiddenUserIds = useMemo(() => new Set(user?.id ? [user.id] : []), [user?.id]);
  // Only workspace admins can invite; anyone else who may create picks from who is here.
  const canInvite = workspaceCan(workspace, "manage_members");
  const loadFailed = rosterFailed || (rosterLoaded && membersWorkspaceId !== workspace.id);

  const { memberIds, emails, hasInvalid } = useMemo(() => pickedSummary(picked), [picked]);
  const tooManyInvites = emails.length > MAX_INVITE_RECIPIENTS;
  const blocked = hasInvalid || tooManyInvites;
  const selectionFirst = (initialPeople?.length ?? 0) > 0;
  // A selection's people are known without the roster; anything typed needs it.
  const showField = selectionFirst || (rosterLoaded && !loadFailed);

  const handleNameChange = (next: string): void => {
    setName(next);
    setNameError(null);
  };

  const handleCreate = async (): Promise<void> => {
    if (isCreating) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError({ kind: "required" });
      nameInputRef.current?.focus();
      return;
    }
    if (blocked) return;
    setIsCreating(true);
    onCreatingChange(true);
    setFailure(null);
    setNameError(null);

    let team: Team;
    try {
      team = await createTeam(workspace.id, { name: trimmedName, memberIds });
    } catch (error) {
      const classified = classifyTeamError(error);
      if (classified.kind === "planRequired") {
        // The capability the form was opened on is stale, so it catches up before the paywall.
        // The form unmounts with its entries: upgrading takes the person to another page, and
        // they start the create again from the Teams page when they come back.
        void useWorkspaceStore
          .getState()
          .refresh({ fresh: true })
          .catch(() => undefined);
        onPlanRequired();
      } else if (classified.kind === "nameTaken") {
        setNameError({ kind: "taken", name: trimmedName });
        setRefocus("name");
      } else {
        // Picks that left since the roster loaded would be refused again, so they come off the
        // field. An answer naming nobody here falls through to the general failure.
        const gone = new Set<string>(
          classified.kind === "notWorkspaceMembers" ? classified.userIds : []
        );
        const goneNames = picked.flatMap((recipient) =>
          recipient.kind === "member" && gone.has(recipient.userId) ? [recipient.label] : []
        );
        if (goneNames.length > 0) {
          setPicked((current) =>
            current.filter(
              (recipient) => recipient.kind !== "member" || !gone.has(recipient.userId)
            )
          );
          setFailure({
            kind: "refused",
            message:
              serverRefusalMessage(error) ??
              t("settingsPage.workspace.teamspaces.members.partialLeft", {
                names: formatList(i18n.language, goneNames.map(isolate)),
              }),
          });
        } else {
          setFailure(
            classified.kind === "refused"
              ? { kind: "refused", message: classified.message }
              : { kind: "general" }
          );
        }
        setRefocus("primary");
      }
      setIsCreating(false);
      onCreatingChange(false);
      return;
    }

    // The team exists from here on, so nothing below may leave it looking uncreated.
    const invite =
      emails.length > 0
        ? await inviteAfterCreate({
            workspaceId: workspace.id,
            target: { teamIds: [team.id] },
            recipients: emails,
          })
        : { invited: [], failed: [], undelivered: 0 };
    const addedNames = picked.flatMap((recipient) =>
      recipient.kind === "member" ? [recipient.label] : []
    );
    try {
      toast(
        createdToast({
          t,
          language: i18n.language,
          team: trimmedName,
          fromSelection: selectionFirst,
          added: addedNames,
          invited: invite.invited,
          failed: invite.failed,
          undelivered: invite.undelivered,
        })
      );
      // The reload doesn't block the form: the team exists and the toast has said so.
      void Promise.resolve(
        onCreated?.(team, { memberCount: addedNames.length + invite.invited.length })
      ).catch((error) => console.error("Create team follow-up failed:", error));
    } catch (error) {
      // The team is made; a failed toast must not leave Creating blocking every way out.
      console.error("Create team follow-up failed:", error);
    } finally {
      onCreatingChange(false);
      onClose();
    }
  };

  const bar = (message: string): ReactElement => (
    <WorkspaceErrorBar tone="error" message={message} />
  );
  const peopleError = hasInvalid
    ? bar(t(`${FORM_KEY}.invalidEmail`))
    : tooManyInvites
      ? bar(t("workspaces.invite.tooMany", { count: MAX_INVITE_RECIPIENTS }))
      : null;

  // A selection arrives with its people chosen, so the note leads and the chips follow it.
  const note =
    isCreating && emails.length > 0 ? (
      <p role="status" className="text-xs leading-snug text-muted-foreground">
        {t(`${FORM_KEY}.creatingStatus`, { team: isolate(name.trim()), count: emails.length })}
      </p>
    ) : (
      <p className="text-xs leading-snug text-muted-foreground">
        {t(selectionFirst ? `${FORM_KEY}.adminNoteShort` : `${FORM_KEY}.adminNote`)}
      </p>
    );

  const primaryLabel = isCreating
    ? t(`${FORM_KEY}.creating`)
    : failure?.kind === "general"
      ? t(`${FORM_KEY}.retry`)
      : t(`${FORM_KEY}.submit`);

  return (
    <>
      <DialogHeader className="items-center gap-3 space-y-0 text-center sm:text-center">
        <div className="flex size-[42px] items-center justify-center rounded-full bg-surface-3 text-foreground">
          <Users className="size-3.5" aria-hidden="true" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <DialogTitle className="text-lg font-medium tracking-normal leading-snug">
            {t(`${FORM_KEY}.title`)}
          </DialogTitle>
          <DialogDescription className="text-sm leading-normal">
            {t(`${FORM_KEY}.subtitle`)}
          </DialogDescription>
        </div>
      </DialogHeader>

      <div className={cn("flex flex-col gap-4", isCreating && "opacity-70")}>
        <div className="space-y-2">
          <label htmlFor="create-team-name" className="text-xs font-medium text-foreground/50">
            {t(`${FORM_KEY}.name`)}
          </label>
          <Input
            ref={nameInputRef}
            dir="auto"
            id="create-team-name"
            value={name}
            autoFocus
            maxLength={80}
            readOnly={isCreating}
            placeholder={t(`${FORM_KEY}.namePlaceholder`)}
            aria-invalid={nameError !== null ? true : undefined}
            onChange={(event) => handleNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleCreate();
            }}
          />
          {nameError?.kind === "required" && bar(t(`${FORM_KEY}.nameRequired`))}
          {nameError?.kind === "taken" &&
            bar(t(`${FORM_KEY}.nameTaken`, { name: isolate(nameError.name) }))}
        </div>

        <div className="space-y-2">
          <label htmlFor="create-team-people" className="text-xs font-medium text-foreground/50">
            {t(`${FORM_KEY}.people`)}
          </label>
          {loadFailed ? (
            <div className="flex items-center justify-between gap-2 rounded border border-border/70 px-3 py-2.5 dark:border-border-subtle/60">
              <p className="text-xs text-muted-foreground">
                {t("settingsPage.workspace.members.loadError")}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadRoster()}
                className="h-6 shrink-0 px-2 text-xs"
              >
                {t("settingsPage.workspace.loadError.retry")}
              </Button>
            </div>
          ) : null}
          {/* A selection's people are known without the roster, so they show (and are sent) even
              while it loads or fails; only suggestions need it. */}
          {showField ? (
            <>
              <SpacePeopleField
                id="create-team-people"
                roster={roster}
                teams={NO_TEAMS}
                hiddenUserIds={hiddenUserIds}
                canInvite={canInvite}
                inviteRoleChoice
                picked={picked}
                onChange={setPicked}
                disabled={isCreating}
                placeholder={t(`${FORM_KEY}.peoplePlaceholder`)}
                note={selectionFirst ? note : undefined}
              />
              {selectionFirst ? null : note}
            </>
          ) : loadFailed ? null : (
            <div className="h-10 animate-pulse rounded-lg bg-foreground/5 dark:bg-white/5" />
          )}
          {peopleError}
          {failure?.kind === "general" && bar(t(`${FORM_KEY}.failed`))}
          {failure?.kind === "refused" && bar(failure.message)}
        </div>
      </div>

      <div className="flex gap-3">
        <button type="button" onClick={onClose} disabled={isCreating} className={SECONDARY_BUTTON}>
          {t(`${FORM_KEY}.cancel`)}
        </button>
        <button
          ref={primaryRef}
          type="button"
          onClick={() => void handleCreate()}
          disabled={isCreating || blocked}
          // Blank reads as not ready, but stays pressable so the missing name can be named.
          className={cn(PRIMARY_BUTTON, !name.trim() && !isCreating && "opacity-60")}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {primaryLabel}
        </button>
      </div>
    </>
  );
}

interface CreatedToastInput {
  t: TFunction;
  language: string;
  team: string;
  /** People chosen on People are counted, as the frame reads, never named. */
  fromSelection: boolean;
  added: string[];
  invited: string[];
  failed: string[];
  undelivered: number;
}

// One line for what happened: who was added, who was invited, or how many couldn't be. More than
// a couple of names would crowd the toast, so a long list is a count.
function createdToast({
  t,
  language,
  team,
  fromSelection,
  added,
  invited,
  failed,
  undelivered,
}: CreatedToastInput): Omit<ToastProps, "id"> {
  const teamName = isolate(team);
  const addedList = formatList(language, added.map(isolate));
  const invitedList = formatList(language, invited.map(isolate));

  let title: string;
  if (failed.length > 0) {
    title = t(`${FORM_KEY}.createdSomeNotInvited`, { team: teamName, count: failed.length });
  } else if (
    added.length > NAMED_PER_LIST ||
    invited.length > NAMED_PER_LIST ||
    (fromSelection && added.length > 0 && invited.length === 0)
  ) {
    title = t(`${FORM_KEY}.createdWithMembers`, {
      team: teamName,
      count: added.length + invited.length,
    });
  } else if (added.length > 0 && invited.length > 0) {
    title = t(`${FORM_KEY}.createdAddedInvited`, {
      team: teamName,
      names: addedList,
      invited: invitedList,
    });
  } else if (added.length > 0) {
    title = t(`${FORM_KEY}.createdAdded`, { team: teamName, names: addedList });
  } else if (invited.length > 0) {
    title = t(`${FORM_KEY}.createdInvited`, { team: teamName, invited: invitedList });
  } else {
    title = t(`${FORM_KEY}.created`, { team: teamName });
  }

  return {
    title,
    ...inviteFollowUpToast({ t, language, failed, undelivered }),
  };
}
