import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceGuests } from "../../hooks/useWorkspaceGuests";
import { workspaceCan } from "../../lib/capabilities";
import { guestDisplayName } from "../../lib/guestsView";
import { isolate } from "../../utils/bidiIsolate";
import { ChevronDown, Copy, FileText, MoreHorizontal, Trash2, UserPlus, Users } from "../icons";
import InviteTeammateDialog from "../InviteTeammateDialog";
import MemberAvatar from "../MemberAvatar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { RemoveGuestsDialog } from "../workspace/RemoveGuestsDialog";
import { cn } from "../lib/utils";
import type { Workspace, WorkspaceGuest } from "../../types/electron";
import { CONTACTS_TRIGGER, HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

const KEY = "settingsPage.workspace.guests";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceGuestsTab({ workspace }: Props): React.ReactElement {
  const { t } = useTranslation();
  // The workspace key remounts the tab per workspace, so the hook only ever sees one id here.
  const { toast } = useToast();
  const { status, guests, reload } = useWorkspaceGuests(workspace.id);
  const canManage = workspaceCan(workspace, "manage_members");
  const [inviting, setInviting] = useState<WorkspaceGuest | null>(null);
  const [removing, setRemoving] = useState<WorkspaceGuest | null>(null);
  // Invitations sent since the invite dialog opened, for the toast when it closes.
  const sentRef = useRef(0);
  const columnCount = canManage ? 3 : 2;

  const copyEmail = async (guest: WorkspaceGuest): Promise<void> => {
    try {
      await navigator.clipboard.writeText(guest.email);
      toast({ title: t("common.copied") });
    } catch {
      // The clipboard can be unavailable; the email stays readable in the row.
    }
  };

  const closeInvite = (open: boolean): void => {
    if (open) return;
    if (sentRef.current > 0) {
      toast({
        title: t(`${KEY}.invite.sent`, {
          count: sentRef.current,
          workspace: isolate(workspace.name),
        }),
      });
    }
    sentRef.current = 0;
    setInviting(null);
  };

  const dialogs = (
    <>
      {inviting ? (
        <InviteTeammateDialog
          open
          onOpenChange={closeInvite}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          initialEmails={[inviting.email]}
          heading={{
            title: t(`${KEY}.invite.title`, { count: 1, workspace: isolate(workspace.name) }),
            description: t(`${KEY}.invite.description`, { workspace: isolate(workspace.name) }),
          }}
          onInvited={(emails) => {
            sentRef.current += emails.length;
          }}
          onInvitationsChanged={() => void reload()}
        />
      ) : null}
      {removing ? (
        <RemoveGuestsDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          workspace={workspace}
          guests={[removing]}
          onRemoved={() => void reload()}
        />
      ) : null}
    </>
  );

  if (status === "ready" && guests.length === 0) return <EmptyGuests />;

  return (
    <div className={TABLE_FRAME}>
      {dialogs}
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          {canManage ? (
            <>
              <col className="w-[50%]" />
              <col className="w-[35%]" />
              <col className="w-[15%]" />
            </>
          ) : (
            <>
              <col className="w-[55%]" />
              <col className="w-[45%]" />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
              {t(`${KEY}.columns.name`)}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-start")}>
              {t(`${KEY}.columns.access`)}
            </th>
            {canManage ? (
              <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-end")}>
                {t(`${KEY}.columns.actions`)}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {status === "ready" ? (
            guests.map((guest) => (
              <GuestRow
                key={guest.email}
                guest={guest}
                canManage={canManage}
                onInvite={() => setInviting(guest)}
                onCopy={() => void copyEmail(guest)}
                onRemove={() => setRemoving(guest)}
              />
            ))
          ) : (
            <tr className={ROW_DIVIDER}>
              <td colSpan={columnCount} className="px-4 py-8 text-center">
                {status === "failed" ? (
                  <div>
                    <p className="text-xs font-medium text-foreground">{t(`${KEY}.failedTitle`)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t(`${KEY}.failedBody`)}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => void reload()}
                    >
                      {t("workspaces.exit.tryAgain")}
                    </Button>
                  </div>
                ) : (
                  <div role="status">
                    <p className="text-xs font-medium text-foreground">
                      {t(`${KEY}.loadingTitle`)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(`${KEY}.loadingBody`)}
                    </p>
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EmptyGuests(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-xl bg-surface-3 text-foreground/70"
      >
        <Users size={20} />
      </span>
      <p className="mt-4 text-sm font-medium text-foreground">{t(`${KEY}.emptyTitle`)}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {t(`${KEY}.emptyBody`)}
      </p>
    </div>
  );
}

interface GuestRowProps {
  guest: WorkspaceGuest;
  canManage: boolean;
  onInvite: () => void;
  onCopy: () => void;
  onRemove: () => void;
}

function GuestRow({
  guest,
  canManage,
  onInvite,
  onCopy,
  onRemove,
}: GuestRowProps): React.ReactElement {
  const hasName = guest.name?.trim();
  return (
    <tr className={cn("h-14", ROW_DIVIDER)}>
      <td className="ps-4 pe-3 max-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <MemberAvatar name={guest.name} email={guest.email} image={guest.image} />
          <div className="min-w-0">
            {hasName ? (
              <>
                <p dir="auto" className="truncate text-xs font-medium text-foreground">
                  {guestDisplayName(guest)}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  <bdi dir="ltr">{guest.email}</bdi>
                </p>
              </>
            ) : (
              <p className="truncate text-xs font-medium text-foreground">
                <bdi dir="ltr">{guest.email}</bdi>
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="ps-3 pe-4 max-w-0">
        <AccessCell guest={guest} />
      </td>
      {canManage ? (
        <td className="ps-3 pe-4 text-end">
          <RowMenu guest={guest} onInvite={onInvite} onCopy={onCopy} onRemove={onRemove} />
        </td>
      ) : null}
    </tr>
  );
}

function AccessCell({ guest }: { guest: WorkspaceGuest }): React.ReactElement {
  const { t } = useTranslation();
  const label = t(`${KEY}.noteCount`, { count: guest.notes.length });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={CONTACTS_TRIGGER}
        aria-label={`${t(`${KEY}.notesMenuLabel`, { name: isolate(guestDisplayName(guest)) })}: ${label}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto p-1.5">
        <ul className="flex flex-col">
          {guest.notes.map((note) => (
            <li key={note.id} className="flex items-center gap-2.5 px-2 py-1.5">
              <FileText aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />
              <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-foreground">
                {note.title?.trim() ? note.title : t("notes.list.untitled")}
              </span>
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({
  guest,
  onInvite,
  onCopy,
  onRemove,
}: Pick<GuestRowProps, "guest" | "onInvite" | "onCopy" | "onRemove">): React.ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t(`${KEY}.menu.label`, { name: isolate(guestDisplayName(guest)) })}
        className="inline-flex h-7 items-center justify-center rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem className="text-xs" onSelect={onInvite}>
          <UserPlus className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t(`${KEY}.menu.invite`)}
        </DropdownMenuItem>
        <DropdownMenuItem className="text-xs" onSelect={onCopy}>
          <Copy className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t(`${KEY}.menu.copyEmail`)}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-xs text-destructive focus:text-destructive"
          onSelect={onRemove}
        >
          <Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t(`${KEY}.menu.remove`)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
