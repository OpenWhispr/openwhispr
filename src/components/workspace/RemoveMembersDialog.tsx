import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  needsTransfer,
  ownerCandidates,
  type MemberRemovalEvent,
  type MemberRemovalState,
} from "../../lib/memberRemovalFlow";
import { classifyRemovalError, type RemovalError } from "../../lib/workspaceErrors";
import { WorkspacesService } from "../../services/WorkspacesService";
import { removeMembers } from "../../services/workspaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type {
  MemberRemovalPreview,
  MemberRemovalResult,
  Workspace,
  WorkspaceMember,
} from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { cn } from "../lib/utils";
import { ChevronsUpDown } from "../icons";
import MemberAvatar from "../MemberAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";
import { PICKER_TRIGGER } from "./dialogButtons";

interface RemoveMembersDialogProps {
  workspace: Workspace;
  roster: WorkspaceMember[];
  state: MemberRemovalState;
  dispatch: (event: MemberRemovalEvent) => void;
  /** Everyone no longer in the workspace once the removal ran, so the tab can deselect them. */
  onRemoved: (removedIds: string[]) => void;
  /** The selection also holds the owner, who isn't removed; the dialog says so. */
  ownerKept?: boolean;
}

const memberName = (member: WorkspaceMember): string => member.name || member.email;

export function RemoveMembersDialog({
  workspace,
  roster,
  state,
  dispatch,
  onRemoved,
  ownerKept = false,
}: RemoveMembersDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refreshMembers = useWorkspaceStore((s) => s.refreshMembers);
  // A second click can land before the running state disables the button.
  const runningRef = useRef(false);
  const pickerLabelId = useId();
  const pickerValueId = useId();
  // The state moves a refused pick back to you, but the error still names who was refused.
  const [refusedOwnerName, setRefusedOwnerName] = useState("");

  const checking = state.kind === "checking";
  const subjectIds = JSON.stringify(
    state.kind === "closed" ? [] : state.subjects.map((subject) => subject.user_id)
  );

  // Once per opening: a new selection, or the same one opened again, checks again.
  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    WorkspacesService.previewMemberRemoval(workspace.id, JSON.parse(subjectIds) as string[]).then(
      (preview: Partial<MemberRemovalPreview> | undefined) => {
        if (cancelled) return;
        // The reply reaches here unchecked; one without a member list reads as a failed preview.
        const owners: unknown = preview?.members;
        dispatch(Array.isArray(owners) ? { type: "previewed", owners } : { type: "previewFailed" });
      },
      (error: unknown) => {
        if (cancelled) return;
        const failure = classifyRemovalError(error);
        dispatch(
          failure.kind === "directoryManaged"
            ? { type: "previewRefused", error: failure }
            : { type: "previewFailed" }
        );
      }
    );
    return () => {
      cancelled = true;
    };
  }, [checking, subjectIds, workspace.id, dispatch]);

  if (state.kind === "closed") return null;

  const { subjects, owners, transferTo, defaultOwnerId } = state;
  const count = subjects.length;
  // Isolated: the dialog and toasts take plain strings, where <bdi> can't go.
  const workspaceName = isolate(workspace.name);
  const firstName = isolate(memberName(subjects[0]));
  const transferring = needsTransfer(state);
  const busy = state.kind === "running";
  const managedRefusal = state.kind === "failed" && state.error?.kind === "directoryManaged";
  // "Untick them" is no use without saying who: the table doesn't mark them.
  const managedIds =
    state.kind === "failed" && state.error?.kind === "directoryManaged" ? state.error.userIds : [];
  const managedSubjects = subjects.filter((subject) => managedIds.includes(subject.user_id));
  const candidates = ownerCandidates(roster, state);
  const newOwner = roster.find((member) => member.user_id === transferTo) ?? null;

  const ownerLabel = (member: WorkspaceMember): string =>
    member.user_id === defaultOwnerId
      ? t("workspaces.removeMembers.you", { name: isolate(memberName(member)) })
      : isolate(memberName(member));

  const doneToast = (
    result: MemberRemovalResult,
    ownerName: string
  ): { title: string; description?: string } => {
    const gone = result.removed.length + result.already_removed.length;
    if (result.removed.length === 0 && result.already_removed.length > 0) {
      return {
        title:
          count === 1
            ? t("workspaces.removeMember.alreadyRemoved", { name: firstName })
            : t("workspaces.removeMembers.alreadyRemoved", {
                count: result.already_removed.length,
              }),
      };
    }
    const removedTitle =
      count === 1
        ? t("settingsPage.workspace.members.removed", { name: firstName })
        : t("workspaces.removeMembers.done", { count: gone });
    if (!result.transferred) return { title: removedTitle };
    const name = isolate(ownerName);
    // The server leaves a note where it is when the new owner can't reach its teamspace. Anyone
    // removed since the preview had their content dealt with then, so only this run counts.
    const ownedNotes = owners
      .filter((owner) => result.removed.includes(owner.user_id))
      .reduce((total, owner) => total + owner.owned_notes, 0);
    const stayed = ownedNotes - result.transferred.notes;
    return stayed > 0
      ? {
          title: removedTitle,
          description: t("workspaces.removeMembers.transferPartial", { count: stayed, name }),
        }
      : { title: t("workspaces.removeMembers.transferDone", { name, count: gone }) };
  };

  const run = async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    // Read now: a refresh after the removal can change the roster before the toast is written.
    const ownerName = newOwner ? memberName(newOwner) : "";
    setRefusedOwnerName(ownerName);
    dispatch({ type: "confirm" });
    try {
      const result = await removeMembers(workspace.id, {
        userIds: subjects.map((subject) => subject.user_id),
        ...(transferring && transferTo ? { transferTo } : {}),
      });
      toast(doneToast(result, ownerName));
      dispatch({ type: "succeeded" });
      onRemoved([...result.removed, ...result.already_removed]);
    } catch (error) {
      const failure = classifyRemovalError(error);
      dispatch({ type: "failed", error: failure });
      // So the picker stops offering the person the server refused.
      if (failure.kind === "invalidTransferTarget") {
        void refreshMembers(workspace.id).catch(() => undefined);
      }
    } finally {
      runningRef.current = false;
    }
  };

  const errorLine = (error: RemovalError): string => {
    switch (error.kind) {
      case "refused":
        return error.message;
      case "notAllowed":
        return t("workspaces.removeMember.notAllowed", { workspace: workspaceName });
      case "ssoRequired":
        return t("workspaces.ssoRequired", { workspace: workspaceName });
      case "invalidTransferTarget":
        return t("workspaces.removeMembers.invalidTarget", { name: isolate(refusedOwnerName) });
      case "cannotRemove":
        return error.reason === "owner"
          ? t("workspaces.removeMembers.cannotRemoveOwner")
          : t("workspaces.removeMembers.cannotRemoveSelf");
      case "directoryManaged": {
        if (count === 1) {
          return t("workspaces.removeMembers.directoryManagedOne", { name: firstName });
        }
        // Only people in this selection can be unticked. No one here means the list can't be
        // read, which says only that the selection can't be removed.
        const managed = subjects.filter((subject) => error.userIds.includes(subject.user_id));
        if (managed.length === 0 || managed.length === count) {
          return t("workspaces.removeMembers.directoryManaged", { count });
        }
        return managed.length === 1
          ? t("workspaces.removeMembers.directoryManagedOneOthers", {
              name: isolate(memberName(managed[0])),
            })
          : t("workspaces.removeMembers.directoryManagedOthers", { count: managed.length });
      }
      // The API reports people already gone in `already_removed`, never as `gone`, and the
      // reducer turns `transferRequired` into the picker; both read as a plain failure.
      case "gone":
      case "transferRequired":
      case "rateLimited":
      case "failed":
        // Without a transfer these show as the dialog's failure state, not as a line under it.
        return transferring
          ? t("workspaces.removeMembers.transferFailed")
          : t("workspaces.removeMembers.failedBody");
    }
  };

  // A plain failure replaces the dialog's question, as the design draws it: nothing changed, and
  // the person can try again or leave. Failures with a reason of their own keep the question and
  // say the reason under it.
  const plainFailure =
    !transferring &&
    state.kind === "failed" &&
    state.error !== undefined &&
    (state.error.kind === "failed" ||
      state.error.kind === "gone" ||
      state.error.kind === "rateLimited" ||
      state.error.kind === "transferRequired");

  let title =
    count === 1
      ? t("workspaces.removeMember.title", { name: firstName, workspace: workspaceName })
      : t("workspaces.removeMembers.title", { count, workspace: workspaceName });

  let body = count === 1 ? t("workspaces.removeMember.body") : t("workspaces.removeMembers.body");
  if (transferring) body = t("workspaces.removeMembers.reassignBody");
  if (plainFailure) {
    title =
      count === 1
        ? t("workspaces.removeMember.failedTitle", { name: firstName })
        : t("workspaces.removeMembers.failedTitle", { count });
    body = t("workspaces.removeMembers.failedBody");
  }
  // Who owns what, said once the picker asks for someone to hand it to.
  const ownerNote =
    count === 1
      ? t("workspaces.removeMembers.ownerOne", { name: firstName })
      : owners.length === count
        ? t("workspaces.removeMembers.ownersAll")
        : t("workspaces.removeMembers.owners", { count: owners.length });

  const primaryLabel = (): string => {
    if (checking) return t("workspaces.removeMembers.checking");
    if (busy) {
      return transferring
        ? t("workspaces.removeMembers.transferring")
        : t("workspaces.removeMember.removing");
    }
    // A failed reassignment keeps its button: nothing was removed, and the same action retries.
    if (transferring) return t("workspaces.removeMembers.transferConfirm");
    if (state.kind === "failed" && !managedRefusal) return t("workspaces.exit.tryAgain");
    return count === 1
      ? t("workspaces.removeMember.confirm")
      : t("workspaces.removeMembers.confirm", { count });
  };

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={title}
      body={body}
      error={
        state.kind === "failed" && state.error && !plainFailure ? errorLine(state.error) : null
      }
      primary={{
        label: primaryLabel(),
        onClick: () => void run(),
        tone: "destructive",
        disabled: checking || managedRefusal || (transferring && !transferTo),
        pending: checking,
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={() => dispatch({ type: "dismiss" })}
    >
      {ownerKept ? (
        <p className="text-center text-sm text-muted-foreground">
          {t("workspaces.removeMembers.cannotRemoveOwner")}
        </p>
      ) : null}
      {transferring ? (
        // The note, the label and the picker sit on one inset card, as the design draws them.
        <div className="flex flex-col gap-3 rounded-xl bg-surface-1 p-3 ring-1 ring-inset ring-black/[0.06] dark:bg-surface-window dark:ring-0">
          <p className="text-sm text-muted-foreground">{ownerNote}</p>
          <div className="flex flex-col gap-2">
            <span id={pickerLabelId} className="text-sm font-medium text-muted-foreground">
              {t("workspaces.removeMembers.transferLabel")}
            </span>
            <DropdownMenu>
              {/* Named by the label and the chosen owner, so both are announced. */}
              <DropdownMenuTrigger
                aria-labelledby={`${pickerLabelId} ${pickerValueId}`}
                disabled={busy || managedRefusal}
                className={cn(PICKER_TRIGGER, "bg-black/[0.04] dark:bg-surface-1 dark:hover:bg-surface-2")}
              >
                {newOwner ? (
                  <MemberAvatar
                    name={newOwner.name}
                    email={newOwner.email}
                    image={newOwner.image}
                    size="row"
                  />
                ) : null}
                <span id={pickerValueId} className="min-w-0 flex-1 truncate text-start">
                  {newOwner ? ownerLabel(newOwner) : ""}
                </span>
                <ChevronsUpDown
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </DropdownMenuTrigger>
              {/* Opens upward, over the title, and never flips: below the picker sit the dialog's
                  buttons, so the second click of a double-click would land on Reassign and
                  remove before the choice was read. */}
              <DropdownMenuContent
                side="top"
                align="start"
                avoidCollisions={false}
                className="max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
              >
                {candidates.map((member) => (
                  <DropdownMenuItem
                    key={member.user_id}
                    // Typeahead matches from the first character, which the label's isolate would be.
                    textValue={memberName(member)}
                    onSelect={() => dispatch({ type: "pickOwner", userId: member.user_id })}
                    className="gap-2.5"
                  >
                    <MemberAvatar
                      name={member.name}
                      email={member.email}
                      image={member.image}
                      size="row"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm">{ownerLabel(member)}</p>
                      {member.name ? (
                        <p className="truncate text-xs text-muted-foreground">
                          <bdi dir="ltr">{member.email}</bdi>
                        </p>
                      ) : null}
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* A member reaches only the teamspaces they belong to, which the design doesn't draw;
              it stays because some notes then stay where they are. */}
          {newOwner?.role === "member" ? (
            <p className="text-xs text-muted-foreground">
              {t("workspaces.removeMembers.transferBodyLimited", {
                name: isolate(memberName(newOwner)),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      {managedSubjects.length > 1 ? (
        <ul className="max-h-24 overflow-y-auto text-xs text-muted-foreground">
          {managedSubjects.map((subject) => (
            <li key={subject.user_id} className="truncate">
              {isolate(memberName(subject))}
            </li>
          ))}
        </ul>
      ) : null}
    </WorkspaceActionDialog>
  );
}
