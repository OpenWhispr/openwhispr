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
import { ChevronDown } from "../icons";
import MemberAvatar from "../MemberAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface RemoveMembersDialogProps {
  workspace: Workspace;
  roster: WorkspaceMember[];
  state: MemberRemovalState;
  dispatch: (event: MemberRemovalEvent) => void;
  /** Everyone no longer in the workspace once the removal ran, so the tab can deselect them. */
  onRemoved: (removedIds: string[]) => void;
}

const memberName = (member: WorkspaceMember): string => member.name || member.email;

export function RemoveMembersDialog({
  workspace,
  roster,
  state,
  dispatch,
  onRemoved,
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
      () => {
        if (!cancelled) dispatch({ type: "previewFailed" });
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
  const candidates = ownerCandidates(roster, state);
  const newOwner = roster.find((member) => member.user_id === transferTo) ?? null;

  const ownerLabel = (member: WorkspaceMember): string =>
    member.user_id === defaultOwnerId
      ? t("workspaces.removeMembers.you", { name: isolate(memberName(member)) })
      : memberName(member);

  const doneTitle = (result: MemberRemovalResult, ownerName: string): string => {
    const gone = result.removed.length + result.already_removed.length;
    if (result.removed.length === 0 && result.already_removed.length > 0) {
      return count === 1
        ? t("workspaces.removeMember.alreadyRemoved", { name: firstName })
        : t("workspaces.removeMembers.alreadyRemoved", { count: result.already_removed.length });
    }
    if (result.transferred) {
      return t("workspaces.removeMembers.transferDone", { name: isolate(ownerName), count: gone });
    }
    return count === 1
      ? t("settingsPage.workspace.members.removed", { name: firstName })
      : t("workspaces.removeMembers.done", { count: gone });
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
      toast({ title: doneTitle(result, ownerName) });
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
      // The API reports people already gone in `already_removed`, never as `gone`, and the
      // reducer turns `transferRequired` into the picker; both read as a plain failure.
      case "gone":
      case "transferRequired":
      case "failed":
        if (transferring) return t("workspaces.removeMembers.transferFailed");
        return count === 1
          ? t("workspaces.removeMember.failed", { name: firstName })
          : t("workspaces.removeMembers.failed", { count });
    }
  };

  const title =
    count === 1
      ? t("workspaces.removeMember.title", { name: firstName, workspace: workspaceName })
      : t("workspaces.removeMembers.title", { count, workspace: workspaceName });

  let body = t("workspaces.removeMember.body");
  if (transferring) {
    body =
      count === 1
        ? t("workspaces.removeMembers.ownerOne", { name: firstName })
        : t("workspaces.removeMembers.owners", { count: owners.length });
  }

  const primaryLabel = (): string => {
    if (checking) return t("workspaces.removeMembers.checking");
    if (busy) {
      return transferring
        ? t("workspaces.removeMembers.transferring")
        : t("workspaces.removeMember.removing");
    }
    if (state.kind === "failed") return t("workspaces.exit.tryAgain");
    if (transferring) return t("workspaces.removeMembers.transferConfirm");
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
      error={state.kind === "failed" && state.error ? errorLine(state.error) : null}
      primary={{
        label: primaryLabel(),
        onClick: () => void run(),
        tone: "destructive",
        disabled: checking || (transferring && !transferTo),
        pending: checking,
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={() => dispatch({ type: "dismiss" })}
    >
      {transferring ? (
        <div className="flex flex-col gap-2">
          <span id={pickerLabelId} className="text-xs font-medium text-muted-foreground">
            {t("workspaces.removeMembers.transferLabel")}
          </span>
          <DropdownMenu>
            {/* Named by the label and the chosen owner, so both are announced. */}
            <DropdownMenuTrigger
              aria-labelledby={`${pickerLabelId} ${pickerValueId}`}
              disabled={busy}
              className="flex h-10 w-full items-center gap-2 rounded-full border border-border/70 bg-surface-1 px-4 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {newOwner ? (
                <MemberAvatar
                  name={newOwner.name}
                  email={newOwner.email}
                  image={newOwner.image}
                  size="sm"
                />
              ) : null}
              <span id={pickerValueId} dir="auto" className="flex-1 truncate text-start">
                {newOwner ? ownerLabel(newOwner) : ""}
              </span>
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            </DropdownMenuTrigger>
            {/* Opens upward, over the title, and never flips: below the picker sit the dialog's
                buttons, so the second click of a double-click would land on Transfer and
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
                  onSelect={() => dispatch({ type: "pickOwner", userId: member.user_id })}
                  className="gap-2.5"
                >
                  <MemberAvatar
                    name={member.name}
                    email={member.email}
                    image={member.image}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p dir="auto" className="truncate text-sm">
                      {ownerLabel(member)}
                    </p>
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
          <p className="text-xs text-muted-foreground">
            {t("workspaces.removeMembers.transferBody")}
          </p>
        </div>
      ) : null}
    </WorkspaceActionDialog>
  );
}
