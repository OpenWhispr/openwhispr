import { useReducer, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { guestDisplayName, hasLinkSharedNote } from "../../lib/guestsView";
import { classifyRowActionError, type RowActionError } from "../../lib/workspaceErrors";
import { GuestsService } from "../../services/GuestsService";
import type { GuestRemoval, Workspace, WorkspaceGuest } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

const KEY = "settingsPage.workspace.guests.remove";

interface RemoveGuestsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  guests: WorkspaceGuest[];
  onRemoved: (result: GuestRemoval) => void;
}

export function RemoveGuestsDialog(props: RemoveGuestsDialogProps): ReactElement | null {
  // Mounted per opening, so each one starts at the confirm step.
  return props.open ? <RemoveGuestsDialogBody {...props} /> : null;
}

function RemoveGuestsDialogBody({
  onOpenChange,
  workspace,
  guests,
  onRemoved,
}: RemoveGuestsDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(confirmActionReducer<WorkspaceGuest[]>, {
    kind: "confirm",
    subject: guests,
  });
  // A second click can land before the running state disables the button.
  const runningRef = useRef(false);

  const count = guests.length;
  const busy = state.kind === "running";
  const workspaceName = isolate(workspace.name);

  const run = async (): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    dispatch({ type: "confirm" });
    try {
      const result = await GuestsService.remove(workspace.id, {
        emails: guests.map((guest) => guest.email),
      });
      // Someone who joined meanwhile is in skipped_members, so only what was removed counts.
      // Nobody removed (all joined meanwhile): the list correcting itself is the only news.
      if (result.removed.length > 0) {
        toast({ title: t(`${KEY}.done`, { count: result.removed.length }) });
      }
      dispatch({ type: "succeeded" });
      onRemoved(result);
      onOpenChange(false);
    } catch (caught) {
      dispatch({ type: "failed", error: classifyRowActionError(caught) });
    } finally {
      runningRef.current = false;
    }
  };

  const errorLine = (error: RowActionError): string => {
    switch (error.kind) {
      case "notAllowed":
        return t("workspaces.removeMember.notAllowed", { workspace: workspaceName });
      case "ssoRequired":
        return t("workspaces.ssoRequired", { workspace: workspaceName });
      default:
        return t(`${KEY}.failed`);
    }
  };

  const dismiss = (): void => {
    dispatch({ type: "dismiss" });
    onOpenChange(false);
  };
  const mayRetry =
    state.kind !== "failed" ||
    (state.error.kind !== "notAllowed" && state.error.kind !== "ssoRequired");

  const body = hasLinkSharedNote(guests)
    ? `${t(`${KEY}.body`)} ${t(`${KEY}.linkShared`)}`
    : t(`${KEY}.body`);

  return (
    <WorkspaceActionDialog
      open
      icon="trash"
      title={
        count === 1
          ? t(`${KEY}.titleOne`, {
              name: isolate(guestDisplayName(guests[0])),
              workspace: workspaceName,
            })
          : t(`${KEY}.title`, { count, workspace: workspaceName })
      }
      body={body}
      error={state.kind === "failed" ? errorLine(state.error) : null}
      primary={
        // Asking again can't change a refusal of permission, so it only offers to close.
        state.kind === "failed" && !mayRetry
          ? { label: t("common.close"), onClick: dismiss, tone: "primary" }
          : {
              label: busy
                ? t(`${KEY}.removing`)
                : state.kind === "failed"
                  ? t("workspaces.exit.tryAgain")
                  : count === 1
                    ? t(`${KEY}.confirmOne`)
                    : t(`${KEY}.confirm`, { count }),
              onClick: () => void run(),
              tone: "destructive",
            }
      }
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={dismiss}
    />
  );
}
