import React, { useEffect, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
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
import { RowCheckbox } from "../dictionary/RowCheckbox";
import { SelectionBar } from "../workspace/SelectionBar";
import type { WorkspaceInvitationsState } from "./useWorkspaceInvitations";

interface WorkspaceInvitationsTabProps {
  workspace: Workspace;
  invitations: WorkspaceInvitationsState;
}

interface InvitationResends {
  bulk: boolean;
  ids: ReadonlySet<string>;
}

const IDLE_RESENDS: InvitationResends = { bulk: false, ids: new Set() };
// Requests continue when Settings closes, so their guards must survive its next mount.
const useInvitationResends = create<ReadonlyMap<string, InvitationResends>>(() => new Map());
const getResends = (workspaceId: string): InvitationResends =>
  useInvitationResends.getState().get(workspaceId) ?? IDLE_RESENDS;

function setResends(workspaceId: string, next: InvitationResends): void {
  useInvitationResends.setState((current) => {
    const updated = new Map(current);
    if (next.bulk || next.ids.size > 0) updated.set(workspaceId, next);
    else updated.delete(workspaceId);
    return updated;
  }, true);
}

const TABLE_FRAME = "rounded-xl border border-border/70 dark:border-border-subtle/70";
const ROW_DIVIDER = "border-t border-border/60 dark:border-border-subtle/50";
// The header sticks over the rows on the settings pane's own background.
const HEADER_CELL =
  "sticky top-0 z-10 h-9 bg-background dark:bg-surface-1 text-xs font-normal text-muted-foreground first:rounded-ss-xl last:rounded-se-xl";
// Display none, so these and their copy under the email are never announced at the same width.
const WIDE_ONLY = "hidden @xl:table-cell";
const SKELETON_ROWS = 3;
const HEADER_CHECKED = { none: false, some: "mixed", all: true } as const;
// A bigger target than the box, without moving it; the important cursor beats the global button rule.
const ROW_CHECKBOX =
  "-m-1 p-1 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-default!";

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
  const { bulk: bulkResending, ids: resendingIds } = useInvitationResends(
    (state) => state.get(workspace.id) ?? IDLE_RESENDS
  );
  const { reload } = invitations;
  // One reading of the clock per render, so the order, the status and the day count agree.
  const now = Date.now();
  const rows = orderInvitations(invitations.invitations, now);
  const rowIds = rows.map((invitation) => invitation.id);
  const rowKey = rowIds.join(",");
  const selectedInvitations = rows.filter((invitation) => selection.has(invitation.id));
  const oneSelected = selectedInvitations.length === 1;
  const headerChecked = HEADER_CHECKED[headerCheckState(rowIds, selection)];

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

  // A canceled invitation frees its seat and a renewed one can take it back, and the seat counts
  // on this page come from the workspace list.
  function refreshSeatsQuietly(): void {
    void useWorkspaceStore.getState().refresh({ fresh: true });
  }

  function setResending(invitationId: string, resending: boolean): void {
    const current = getResends(workspace.id);
    const ids = new Set(current.ids);
    if (resending) ids.add(invitationId);
    else ids.delete(invitationId);
    setResends(workspace.id, { ...current, ids });
  }

  async function handleResend(invitation: WorkspaceInvitation): Promise<void> {
    const current = getResends(workspace.id);
    if (current.bulk || current.ids.has(invitation.id)) return;
    setResending(invitation.id, true);
    try {
      const { email_sent } = await InvitationsService.resend(workspace.id, invitation.id);
      await reload();
      refreshSeatsQuietly();
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
      } else if (failure.kind === "rateLimited") {
        toast({
          title: t("common.error"),
          description: t("workspaces.invite.errors.rateLimited"),
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
    const current = getResends(workspace.id);
    if (current.bulk || current.ids.size > 0) return;
    setResends(workspace.id, { ...current, bulk: true });
    const emailsById = new Map(selectedInvitations.map(({ id, email }) => [id, email]));
    // The run still reports if People closes, since its toast outlives the tab. A sign-in change
    // ends it through the auth generation.
    try {
      const outcome = await bulkInvitationActions.resendInvitations(
        workspace.id,
        selectedInvitations.map(({ id }) => id)
      );
      const listed = await reload();
      refreshSeatsQuietly();
      const listedIds = listed && new Set(listed.map(({ id }) => id));
      // A failure that left the list was accepted or canceled meanwhile, so it has no Actions to
      // retry from and may have added a member. A failed reload says nothing about any of them.
      const gone = listedIds ? outcome.failed.filter(({ id }) => !listedIds.has(id)) : [];
      const failed = outcome.failed.filter((failure) => !gone.includes(failure));
      if (gone.length > 0) refreshMembersQuietly();
      const { done, noEmail } = outcome;
      // Updated but not emailed: the old link no longer works and the new one reached nobody. Those
      // stay selected along with the failures, so Resend invites again retries only these.
      const delivered = done.filter((id) => !noEmail.includes(id));
      setSelection((current) => setRows(current, delivered, false));

      // Why the failures failed, when something other than the connection can say.
      const failureReason = (): string | null => {
        const ended = failed.find(
          ({ error }) => error.kind === "notAllowed" || error.kind === "ssoRequired"
        );
        if (ended?.error.kind === "ssoRequired") {
          return t("workspaces.ssoRequired", { workspace: isolate(workspace.name) });
        }
        if (ended) {
          return t("settingsPage.workspace.people.invitations.resendNotAllowed", {
            workspace: isolate(workspace.name),
          });
        }
        if (failed.some(({ error }) => error.kind === "rateLimited")) {
          return t("workspaces.invite.errors.rateLimited");
        }
        for (const { error } of failed) {
          if (error.kind === "refused") return error.message;
        }
        // Still listed, so this is an expired invitation the server won't renew. Trying again can't
        // help, unlike the connection failures below. A failed reload can't tell.
        const unrenewable = listedIds
          ? failed.filter(({ error }) => error.kind === "gone").length
          : 0;
        return unrenewable > 0
          ? t("settingsPage.workspace.people.invitations.resendUnrenewable", {
              count: unrenewable,
            })
          : null;
      };

      let goneLine: string | null = null;
      if (gone.length === 1) {
        goneLine = t("settingsPage.workspace.people.invitations.noLongerPending", {
          email: isolate(emailsById.get(gone[0].id) ?? ""),
        });
      } else if (gone.length > 1) {
        goneLine = t("settingsPage.workspace.people.invitations.noLongerPendingMany", {
          count: gone.length,
        });
      }
      if (failed.length === 0 && delivered.length === 0) {
        if (goneLine) toast({ title: goneLine });
      } else if (failed.length === 0) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentMany", {
            count: delivered.length,
          }),
          ...(goneLine ? { description: goneLine } : {}),
        });
      } else if (delivered.length > 0) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentPartial", {
            count: delivered.length,
          }),
          description:
            failureReason() ??
            (failed.length === 1
              ? t("settingsPage.workspace.people.invitations.resendFailedOne", {
                  email: isolate(emailsById.get(failed[0].id) ?? ""),
                })
              : t("settingsPage.workspace.people.invitations.resendFailedSome", {
                  count: failed.length,
                })),
        });
      } else {
        toast({
          title:
            failureReason() ??
            t("settingsPage.workspace.people.invitations.resendFailedAll", {
              count: failed.length,
            }),
          variant: "destructive",
        });
      }
      // Neutral news, so it stays out from under a failure's text.
      if (failed.length > 0 && goneLine) toast({ title: goneLine });
      if (noEmail.length === 1) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentNoEmailOne", {
            email: isolate(emailsById.get(noEmail[0]) ?? ""),
          }),
          variant: "destructive",
        });
      } else if (noEmail.length > 1) {
        toast({
          title: t("settingsPage.workspace.people.invitations.resentNoEmailMany", {
            count: noEmail.length,
          }),
          variant: "destructive",
        });
      }
    } finally {
      setResends(workspace.id, { ...getResends(workspace.id), bulk: false });
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

      {invitations.stale && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>{t("settingsPage.workspace.people.invitations.refreshFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t("workspaces.exit.tryAgain")}
          </Button>
        </div>
      )}

      {rows.length > 0 && (
        // A container, since the settings pane's width isn't the viewport's. Below @xl the role and
        // status columns move under the email, which then wraps so rows can be told apart.
        <div className={cn(TABLE_FRAME, "@container")}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cn(HEADER_CELL, "w-10 ps-4 pe-0 text-start")}>
                  <RowCheckbox
                    label={t("settingsPage.workspace.people.selection.selectAllInvitations")}
                    checked={headerChecked}
                    disabled={bulkResending}
                    className={ROW_CHECKBOX}
                    onToggle={() =>
                      setSelection((current) => setRows(current, rowIds, headerChecked !== true))
                    }
                  />
                </th>
                <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-3 text-start")}>
                  {t("settingsPage.workspace.people.columns.email")}
                </th>
                <th
                  scope="col"
                  className={cn(HEADER_CELL, WIDE_ONLY, "px-3 text-start whitespace-nowrap")}
                >
                  {t("settingsPage.workspace.people.columns.role")}
                </th>
                <th
                  scope="col"
                  className={cn(HEADER_CELL, WIDE_ONLY, "px-3 text-start whitespace-nowrap")}
                >
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
                const role = t(`settingsPage.workspace.role.${invitation.workspace_role}`);
                const status = expired
                  ? t("settingsPage.workspace.people.invitations.expired")
                  : t("settingsPage.workspace.people.invitations.pending", {
                      count: invitationDaysLeft(invitation, now),
                    });
                return (
                  <tr key={invitation.id} className={cn("h-14", ROW_DIVIDER)}>
                    <td className="w-10 ps-4 pe-0">
                      <RowCheckbox
                        label={t("settingsPage.workspace.people.selection.selectRow", {
                          name: isolate(invitation.email),
                        })}
                        checked={selection.has(invitation.id)}
                        disabled={bulkResending}
                        className={ROW_CHECKBOX}
                        onToggle={() =>
                          setSelection((current) => toggleRow(current, invitation.id))
                        }
                      />
                    </td>
                    {/* max-w-0 keeps the email from widening the column in an auto-layout table. */}
                    <td className="ps-3 pe-3 py-2 @xl:py-0 w-full max-w-0">
                      <p className="text-xs font-medium text-foreground break-all @xl:truncate">
                        <bdi dir="ltr">{invitation.email}</bdi>
                      </p>
                      <p className="@xl:hidden mt-0.5 text-xs text-muted-foreground">
                        {role} ·{" "}
                        <span className={expired ? "text-destructive" : undefined}>{status}</span>
                      </p>
                    </td>
                    <td className={cn(WIDE_ONLY, "px-3 whitespace-nowrap text-xs text-foreground")}>
                      {role}
                    </td>
                    <td
                      className={cn(
                        WIDE_ONLY,
                        "px-3 whitespace-nowrap text-xs",
                        expired ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {status}
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
            id: "cancel",
            // One invitation goes through its own dialog, which can name who it's for.
            label: t(
              `settingsPage.workspace.people.invitations.${oneSelected ? "cancel" : "cancelSelected"}`
            ),
            tone: "destructive",
            onClick: () =>
              oneSelected
                ? dispatchCancel({ type: "open", subject: selectedInvitations[0] })
                : dispatchCancelMany({ type: "open", subject: selectedInvitations }),
          },
          {
            id: "resend",
            label:
              bulkResending || resendingIds.size > 0
                ? t("settingsPage.workspace.people.invitations.resendingSelected")
                : t(
                    `settingsPage.workspace.people.invitations.${oneSelected ? "resend" : "resendSelected"}`
                  ),
            busy: bulkResending || resendingIds.size > 0,
            onClick: () => void handleResendSelected(),
          },
        ]}
      />

      <CancelInvitationsDialog
        workspace={workspace}
        state={cancelManyState}
        dispatch={dispatchCancelMany}
        onCanceled={(settledIds, anyGone) => {
          void reload();
          refreshSeatsQuietly();
          if (anyGone) refreshMembersQuietly();
          setSelection((current) => setRows(current, settledIds, false));
        }}
      />

      <CancelInvitationDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        state={cancelState}
        dispatch={dispatchCancel}
        onCanceled={(outcome) => {
          void reload();
          refreshSeatsQuietly();
          if (outcome === "gone") refreshMembersQuietly();
        }}
      />
    </div>
  );
}
