import React, { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MoreHorizontal, Trash2 } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { isolate } from "../../utils/bidiIsolate";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { invitationDaysLeft, invitationStatus, orderInvitations } from "../../lib/peopleRoster";
import {
  headerCheckState,
  keepRows,
  setRows,
  toggleRow,
  type RowSelection,
} from "../../lib/rowSelection";
import { classifyRowActionError } from "../../lib/workspaceErrors";
import { bulkInvitationActions } from "../../services/bulkInvitationActions";
import { InvitationsService } from "../../services/InvitationsService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace, WorkspaceInvitation } from "../../types/electron";
import { CancelInvitationDialog } from "../workspace/CancelInvitationDialog";
import { CancelInvitationsDialog } from "../workspace/CancelInvitationsDialog";
import { RowCheckbox, SelectionBar } from "../workspace/SelectionBar";
import type { WorkspaceInvitationsState } from "./useWorkspaceInvitations";

interface WorkspaceInvitationsTabProps {
  workspace: Workspace;
  invitations: WorkspaceInvitationsState;
}

const TABLE_FRAME = "rounded-xl border border-border/70 dark:border-border-subtle/70";
const ROW_DIVIDER = "border-t border-border/60 dark:border-border-subtle/50";
// The header sticks over the rows on the settings pane's own background.
const HEADER_CELL =
  "sticky top-0 z-10 h-9 bg-background dark:bg-surface-1 text-xs font-normal text-muted-foreground first:rounded-ss-xl last:rounded-se-xl";
const SKELETON_ROWS = 3;
const HEADER_CHECKED = { none: false, some: "mixed", all: true } as const;

export default function WorkspaceInvitationsTab({
  workspace,
  invitations,
}: WorkspaceInvitationsTabProps): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [cancelState, dispatchCancel] = useReducer(confirmActionReducer<WorkspaceInvitation>, {
    kind: "closed",
  });
  const [cancelManyState, dispatchCancelMany] = useReducer(
    confirmActionReducer<WorkspaceInvitation[]>,
    { kind: "closed" }
  );
  const [selection, setSelection] = useState<RowSelection>(() => new Set());
  const [bulkResending, setBulkResending] = useState(false);
  const bulkResendingRef = useRef(false);
  const [resendingIds, setResendingIds] = useState<ReadonlySet<string>>(() => new Set());
  // Read synchronously, so a second Resend on a row still sending is ignored before any render.
  const resendingRef = useRef(new Set<string>());
  const { reload } = invitations;
  // One reading of the clock per render, so the order, the status and the day count agree.
  const now = Date.now();
  const rows = orderInvitations(invitations.invitations, now);
  const rowIds = rows.map((invitation) => invitation.id);
  const rowKey = rowIds.join(",");
  const selectedInvitations = rows.filter((invitation) => selection.has(invitation.id));

  useEffect(() => {
    setSelection((current) => (current.size === 0 ? current : new Set()));
  }, [workspace.id]);

  // Cancel and Resend act on what is listed, so a reload that drops an invitation drops it here.
  useEffect(() => {
    setSelection((current) => keepRows(current, rowIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKey]);

  // An invitation that left the list may have been accepted, which adds a member.
  function refreshMembersQuietly(): void {
    void useWorkspaceStore
      .getState()
      .refreshMembers(workspace.id)
      .catch(() => undefined);
  }

  function setResending(invitationId: string, resending: boolean): void {
    if (resending) resendingRef.current.add(invitationId);
    else resendingRef.current.delete(invitationId);
    setResendingIds(new Set(resendingRef.current));
  }

  async function handleResend(invitation: WorkspaceInvitation): Promise<void> {
    if (resendingRef.current.has(invitation.id)) return;
    setResending(invitation.id, true);
    try {
      const { email_sent } = await InvitationsService.resend(workspace.id, invitation.id);
      await reload();
      toast(
        email_sent
          ? { title: t("settingsPage.workspace.invites.resent") }
          : {
              title: t("settingsPage.workspace.invites.resentNoEmail"),
              variant: "destructive",
            }
      );
    } catch (error) {
      const failure = classifyRowActionError(error);
      if (failure.kind === "gone") {
        // The API answers 404 both for an invitation accepted or canceled meanwhile and for an
        // expired one it won't renew; only the list says which this was.
        const listed = await reload();
        const stillListed = listed?.some((entry) => entry.id === invitation.id) ?? true;
        if (!stillListed) refreshMembersQuietly();
        toast({
          title: t(
            stillListed
              ? "settingsPage.workspace.people.invitations.resendFailed"
              : "settingsPage.workspace.people.invitations.noLongerPending",
            { email: isolate(invitation.email) }
          ),
          variant: stillListed ? "destructive" : undefined,
        });
      } else if (failure.kind === "ssoRequired") {
        toast({
          title: t("workspaces.ssoRequired", { workspace: isolate(workspace.name) }),
          variant: "destructive",
        });
      } else if (failure.kind === "notAllowed") {
        toast({
          title: t("settingsPage.workspace.people.invitations.resendNotAllowed", {
            workspace: isolate(workspace.name),
          }),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("common.error"),
          description: failure.kind === "refused" ? failure.message : t("common.unknownError"),
          variant: "destructive",
        });
      }
    } finally {
      setResending(invitation.id, false);
    }
  }

  async function handleResendSelected(): Promise<void> {
    if (bulkResendingRef.current) return;
    bulkResendingRef.current = true;
    setBulkResending(true);
    const emailsById = new Map(selectedInvitations.map(({ id, email }) => [id, email]));
    // Not stopped when the tab unmounts (every People tab change does): the run finishes and
    // still reports, since the toast and the invitations list outlive the tab. A sign-in change
    // ends it through the auth generation.
    try {
      const outcome = await bulkInvitationActions.resendInvitations(
        workspace.id,
        selectedInvitations.map(({ id }) => id)
      );
      const listed = await reload();
      // A failure that left the list may be an invitation that was accepted.
      if (
        listed &&
        outcome.failed.some(
          ({ id, error }) => error.kind === "gone" && !listed.some((entry) => entry.id === id)
        )
      ) {
        refreshMembersQuietly();
      }
      // Failed invitations stay selected, so Resend invites again retries only those.
      setSelection((current) => setRows(current, outcome.done, false));

      const { done, failed, noEmail } = outcome;
      const ended = failed.find(
        ({ error }) => error.kind === "notAllowed" || error.kind === "ssoRequired"
      );
      if (failed.length === 0) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentMany", { count: done.length }),
        });
      } else if (done.length > 0) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentPartial", {
            count: done.length,
          }),
          description: t("settingsPage.workspace.people.invitations.resendFailedSome", {
            count: failed.length,
            email: isolate(emailsById.get(failed[0].id) ?? ""),
          }),
        });
      } else if (ended?.error.kind === "ssoRequired") {
        toast({
          title: t("workspaces.ssoRequired", { workspace: isolate(workspace.name) }),
          variant: "destructive",
        });
      } else if (ended) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resendNotAllowed", {
            workspace: isolate(workspace.name),
          }),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("settingsPage.workspace.people.invitations.resendFailedAll", {
            count: failed.length,
          }),
          variant: "destructive",
        });
      }
      if (noEmail.length > 0) {
        toast({
          title: t("settingsPage.workspace.invites.resentNoEmail"),
          variant: "destructive",
        });
      }
    } finally {
      bulkResendingRef.current = false;
      setBulkResending(false);
    }
  }

  return (
    <div className="space-y-4">
      {rows.length === 0 && invitations.status === "failed" && (
        <div className={cn(TABLE_FRAME, "px-4 py-8 text-center")}>
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.people.invitations.failedTitle")}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settingsPage.workspace.people.failed.body")}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void reload()}>
            {t("workspaces.exit.tryAgain")}
          </Button>
        </div>
      )}

      {rows.length === 0 && (invitations.status === "loading" || invitations.status === "idle") && (
        <div className={TABLE_FRAME}>
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              aria-hidden="true"
              className={cn("flex h-14 items-center px-4", index > 0 && ROW_DIVIDER)}
            >
              <div className="h-2.5 w-40 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
            </div>
          ))}
          <div role="status" className={cn("px-4 py-5 text-center", ROW_DIVIDER)}>
            <p className="text-xs font-medium text-foreground">
              {t("settingsPage.workspace.people.invitations.loading")}
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 && invitations.status === "ready" && (
        <div className={cn(TABLE_FRAME, "px-4 py-8 text-center")}>
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.people.invitations.emptyTitle")}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settingsPage.workspace.people.invitations.emptyBody")}
          </p>
        </div>
      )}

      {rows.length > 0 && invitations.stale && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>{t("settingsPage.workspace.people.invitations.refreshFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t("workspaces.exit.tryAgain")}
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        <div className={TABLE_FRAME}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cn(HEADER_CELL, "w-10 ps-4 pe-0 text-start")}>
                  <RowCheckbox
                    label={t("settingsPage.workspace.people.selection.selectAllInvitations")}
                    checked={HEADER_CHECKED[headerCheckState(rowIds, selection)]}
                    disabled={bulkResending}
                    onChange={(checked) =>
                      setSelection((current) => setRows(current, rowIds, checked))
                    }
                  />
                </th>
                <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-3 text-start")}>
                  {t("settingsPage.workspace.people.columns.email")}
                </th>
                <th scope="col" className={cn(HEADER_CELL, "px-3 text-start whitespace-nowrap")}>
                  {t("settingsPage.workspace.people.columns.role")}
                </th>
                <th scope="col" className={cn(HEADER_CELL, "px-3 text-start whitespace-nowrap")}>
                  {t("settingsPage.workspace.people.columns.status")}
                </th>
                <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-end whitespace-nowrap")}>
                  {t("settingsPage.workspace.people.columns.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((invitation) => {
                const expired = invitationStatus(invitation, now) === "expired";
                const resending = resendingIds.has(invitation.id);
                return (
                  <tr key={invitation.id} className={cn("h-14", ROW_DIVIDER)}>
                    <td className="w-10 ps-4 pe-0">
                      <RowCheckbox
                        label={t("settingsPage.workspace.people.selection.selectRow", {
                          name: isolate(invitation.email),
                        })}
                        checked={selection.has(invitation.id)}
                        disabled={bulkResending}
                        onChange={() =>
                          setSelection((current) => toggleRow(current, invitation.id))
                        }
                      />
                    </td>
                    {/* max-w-0 lets the email truncate inside an auto-layout table. */}
                    <td className="ps-3 pe-3 w-full max-w-0">
                      <p className="text-xs font-medium text-foreground truncate">
                        <bdi dir="ltr">{invitation.email}</bdi>
                      </p>
                    </td>
                    <td className="px-3 whitespace-nowrap text-xs text-foreground">
                      {t(`settingsPage.workspace.role.${invitation.workspace_role}`)}
                    </td>
                    <td
                      className={cn(
                        "px-3 whitespace-nowrap text-xs",
                        expired ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {expired
                        ? t("settingsPage.workspace.people.invitations.expired")
                        : t("settingsPage.workspace.people.invitations.pending", {
                            count: invitationDaysLeft(invitation, now),
                          })}
                    </td>
                    <td className="ps-3 pe-4 w-px whitespace-nowrap text-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          disabled={resending || bulkResending}
                          aria-label={t("common.actions")}
                          className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30 active:bg-foreground/8 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-foreground/5 dark:hover:bg-white/5"
                        >
                          {resending ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                              {t("settingsPage.workspace.invites.resending")}
                            </>
                          ) : (
                            <MoreHorizontal className="size-4" aria-hidden="true" />
                          )}
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            className="text-xs"
                            onSelect={() => void handleResend(invitation)}
                          >
                            {t("settingsPage.workspace.people.invitations.resend")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs text-destructive focus:text-destructive"
                            onSelect={() => dispatchCancel({ type: "open", subject: invitation })}
                          >
                            <Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
                            {t("settingsPage.workspace.people.invitations.cancel")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SelectionBar
        count={selectedInvitations.length}
        onClear={() => setSelection(new Set())}
        actions={[
          {
            label: t("settingsPage.workspace.people.invitations.cancelSelected"),
            tone: "destructive",
            onClick: () => dispatchCancelMany({ type: "open", subject: selectedInvitations }),
          },
          {
            label: bulkResending
              ? t("settingsPage.workspace.people.invitations.resendingSelected")
              : t("settingsPage.workspace.people.invitations.resendSelected"),
            busy: bulkResending,
            onClick: () => void handleResendSelected(),
          },
        ]}
      />

      <CancelInvitationsDialog
        workspace={workspace}
        state={cancelManyState}
        dispatch={dispatchCancelMany}
        onCanceled={(canceledIds) => {
          void reload();
          setSelection((current) => setRows(current, canceledIds, false));
        }}
      />

      <CancelInvitationDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        state={cancelState}
        dispatch={dispatchCancel}
        onCanceled={(outcome) => {
          void reload();
          if (outcome === "gone") refreshMembersQuietly();
        }}
      />
    </div>
  );
}
