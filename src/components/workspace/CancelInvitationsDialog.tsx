import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ConfirmActionEvent, ConfirmActionState } from "../../lib/confirmActionFlow";
import type { RowActionError } from "../../lib/workspaceErrors";
import { bulkInvitationActions } from "../../services/bulkInvitationActions";
import type { Workspace, WorkspaceInvitation } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface CancelInvitationsDialogProps {
  workspace: Workspace;
  state: ConfirmActionState<WorkspaceInvitation[]>;
  dispatch: (event: ConfirmActionEvent<WorkspaceInvitation[]>) => void;
  /** Invitations no longer pending, reported as each run ends so the tab can reload and deselect. */
  onCanceled: (canceledIds: string[]) => void;
}

export function CancelInvitationsDialog({
  workspace,
  state,
  dispatch,
  onCanceled,
}: CancelInvitationsDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  // The invitations a failed run left, which Try again asks for instead of the whole selection.
  const [stillFailing, setStillFailing] = useState<string[] | null>(null);
  // Across tries, so the toast counts everything canceled since the dialog opened.
  const canceledTotalRef = useRef(0);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // A dialog that goes away mid-run stops asking for the invitations it hasn't reached.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (state.kind === "closed") return null;

  const busy = state.kind === "running";
  const pendingIds =
    state.kind === "confirm" || !stillFailing
      ? state.subject.map((invitation) => invitation.id)
      : stillFailing;

  const run = async (): Promise<void> => {
    // A second click can land before the running state disables the button.
    if (runningRef.current) return;
    runningRef.current = true;
    if (state.kind === "confirm") {
      canceledTotalRef.current = 0;
      setStillFailing(null);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "confirm" });
    try {
      const outcome = await bulkInvitationActions.cancelInvitations(
        workspace.id,
        pendingIds,
        controller.signal
      );
      if (controller.signal.aborted) return;
      canceledTotalRef.current += outcome.done.length;

      if (outcome.failed.length === 0) {
        toast({
          title: t("workspaces.cancelInvitations.done", { count: canceledTotalRef.current }),
        });
        dispatch({ type: "succeeded" });
      } else {
        setStillFailing(outcome.failed.map(({ id }) => id));
        // Permission and single sign-on end the run, so the first failure speaks for the rest.
        const ended = outcome.failed.find(
          ({ error }) => error.kind === "notAllowed" || error.kind === "ssoRequired"
        );
        dispatch({ type: "failed", error: ended?.error ?? { kind: "failed" } });
      }
      if (outcome.done.length > 0) onCanceled(outcome.done);
    } finally {
      runningRef.current = false;
    }
  };

  const errorLine = (error: RowActionError): string => {
    const workspaceName = isolate(workspace.name);
    switch (error.kind) {
      case "notAllowed":
        return t("workspaces.cancelInvitation.notAllowed", { workspace: workspaceName });
      case "ssoRequired":
        return t("workspaces.ssoRequired", { workspace: workspaceName });
      default:
        return t("workspaces.cancelInvitations.partial", { count: pendingIds.length });
    }
  };

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={t("workspaces.cancelInvitations.title", { count: pendingIds.length })}
      body={t("workspaces.cancelInvitations.body")}
      error={state.kind === "failed" ? errorLine(state.error) : null}
      primary={{
        label: busy
          ? t("workspaces.cancelInvitation.canceling")
          : state.kind === "failed"
            ? t("workspaces.exit.tryAgain")
            : t("workspaces.cancelInvitations.confirm"),
        onClick: () => void run(),
        tone: "destructive",
      }}
      cancelLabel={t("workspaces.cancelInvitations.keep")}
      busy={busy}
      onDismiss={() => dispatch({ type: "dismiss" })}
    />
  );
}
