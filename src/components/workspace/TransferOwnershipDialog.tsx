import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../hooks/useAuth";
import {
  transferCandidates,
  type TransferEvent,
  type TransferState,
} from "../../lib/workspaceTransferFlow";
import { serverRefusalMessage } from "../../services/cloudApi";
import { transferOwnership } from "../../services/workspaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace, WorkspaceMember } from "../../types/electron";
import { ChevronDown } from "../icons";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { WorkspaceActionDialog } from "./WorkspaceActionDialog";

interface TransferOwnershipDialogProps {
  workspace: Workspace;
  state: TransferState;
  dispatch: (event: TransferEvent) => void;
  /** Runs after the transfer succeeded and the dialog closed. */
  onTransferred: (newOwner: WorkspaceMember) => void;
}

type RosterLoad = "idle" | "loading" | "loaded" | "error";

const memberName = (member: WorkspaceMember): string => member.name || member.email;

export function TransferOwnershipDialog({
  workspace,
  state,
  dispatch,
  onTransferred,
}: TransferOwnershipDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const members = useWorkspaceStore((s) => s.members);
  const refreshMembers = useWorkspaceStore((s) => s.refreshMembers);
  const [load, setLoad] = useState<RosterLoad>("idle");
  const [loadAttempt, setLoadAttempt] = useState(0);

  const open = state.kind !== "closed";

  // Read on every opening: a roster from an earlier visit to Members can offer someone who has
  // left since, and the server would refuse the transfer every time.
  useEffect(() => {
    if (!open) {
      setLoad("idle");
      return;
    }
    let cancelled = false;
    setLoad("loading");
    refreshMembers(workspace.id).then(
      () => {
        if (!cancelled) setLoad("loaded");
      },
      () => {
        if (!cancelled) setLoad("error");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, workspace.id, loadAttempt, refreshMembers]);

  const candidates = useMemo(
    () => transferCandidates(members, user?.id ?? ""),
    [members, user?.id]
  );

  if (state.kind === "closed") return null;

  const status: "loading" | "error" | "ready" =
    load === "error" ? "error" : load === "loaded" ? "ready" : "loading";

  // Looked up in the whole roster: once the transfer lands the new owner is no
  // longer a candidate, but the dialog still names them until it closes.
  const picked =
    state.kind === "choosing" && !state.candidateId
      ? null
      : (members.find((m) => m.user_id === state.candidateId) ?? null);
  const pickedName = picked ? memberName(picked) : "";
  const busy = state.kind === "transferring";

  const dismiss = (): void => dispatch({ type: "dismiss" });

  const run = async (target: WorkspaceMember): Promise<void> => {
    dispatch({ type: "confirm" });
    try {
      await transferOwnership(workspace.id, target.user_id);
    } catch (error) {
      dispatch({ type: "failed", reason: serverRefusalMessage(error) });
      return;
    }
    dismiss();
    toast({ title: t("workspaces.transfer.done", { name: memberName(target) }) });
    onTransferred(target);
  };

  let title = t("workspaces.transfer.title");
  let body = t("workspaces.transfer.body");
  if (busy) {
    title = t("workspaces.transfer.transferringTitle");
    body = t("workspaces.transfer.transferringBody");
  } else if (picked) {
    title = t("workspaces.transfer.confirmTitle", { name: pickedName });
    body = t("workspaces.transfer.confirmBody", { name: pickedName, workspace: workspace.name });
  }

  const primaryLabel = busy
    ? t("workspaces.transfer.transferring")
    : state.kind === "failed"
      ? t("workspaces.exit.tryAgain")
      : t("workspaces.transfer.submit");

  const roleLabel = (member: WorkspaceMember): string =>
    t(`settingsPage.workspace.role.${member.role}`);
  const candidateLabel = (member: WorkspaceMember): string =>
    t("workspaces.transfer.candidate", { name: memberName(member), role: roleLabel(member) });

  const noCandidates = status === "ready" && candidates.length === 0;
  const pickerDisabled = status !== "ready" || noCandidates || busy;
  const canSubmit = status === "ready" && picked !== null && !noCandidates;

  return (
    <WorkspaceActionDialog
      open
      icon="info"
      title={title}
      body={body}
      error={state.kind === "failed" ? (state.reason ?? t("workspaces.transfer.failed")) : null}
      primary={{
        label: primaryLabel,
        onClick: () => {
          if (picked) void run(picked);
        },
        tone: "primary",
        disabled: !canSubmit,
      }}
      cancelLabel={t("common.cancel")}
      busy={busy}
      onDismiss={dismiss}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t("workspaces.transfer.newOwner")}
        </span>
        {status === "loading" ? (
          <div className="h-10 animate-pulse rounded-full bg-foreground/5 dark:bg-white/5" />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={pickerDisabled}
              className={cn(
                "flex h-10 w-full items-center justify-between gap-2 rounded-full border border-border/70 bg-surface-1 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                picked ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span dir="auto" className="truncate">
                {picked ? candidateLabel(picked) : t("workspaces.transfer.placeholder")}
              </span>
              <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
            </DropdownMenuTrigger>
            {/* Opens upward, over the title, and never flips: below the picker sit the dialog's
                buttons, and picking enables Transfer ownership, so a double-click would land
                on it and transfer before the confirmation was read. */}
            <DropdownMenuContent
              side="top"
              align="start"
              avoidCollisions={false}
              className="max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
            >
              {candidates.map((member) => (
                <DropdownMenuItem
                  key={member.user_id}
                  onSelect={() => dispatch({ type: "pick", candidateId: member.user_id })}
                >
                  <span dir="auto" className="truncate">
                    {candidateLabel(member)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {status === "error" ? (
          <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t("settingsPage.workspace.members.loadError")}</span>
            <button
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              className="font-medium text-foreground underline underline-offset-2"
            >
              {t("common.retry")}
            </button>
          </p>
        ) : null}
        {noCandidates ? (
          <p className="text-xs text-muted-foreground">
            {t("workspaces.transfer.noCandidates", { workspace: workspace.name })}
          </p>
        ) : null}
      </div>
    </WorkspaceActionDialog>
  );
}
