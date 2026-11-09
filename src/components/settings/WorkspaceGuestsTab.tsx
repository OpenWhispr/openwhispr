import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceGuests } from "../../hooks/useWorkspaceGuests";
import { workspaceCan } from "../../lib/capabilities";
import { guestDisplayName } from "../../lib/guestsView";
import {
  headerCheckState,
  keepRows,
  setRows,
  toggleRow,
  type RowSelection,
} from "../../lib/rowSelection";
import { classifyRowActionError } from "../../lib/workspaceErrors";
import { GuestsService } from "../../services/GuestsService";
import { CloudApiError } from "../../services/cloudApi";
import { isolate } from "../../utils/bidiIsolate";
import {
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  MoreHorizontal,
  Trash2,
  UserPlus,
  Users,
  X,
} from "../icons";
import { RowCheckbox } from "../dictionary/RowCheckbox";
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
import { SelectionBar } from "../workspace/SelectionBar";
import { cn } from "../lib/utils";
import type { Workspace, WorkspaceGuest } from "../../types/electron";
import { CONTACTS_TRIGGER, HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

const KEY = "settingsPage.workspace.guests";
const HEADER_CHECKED = { none: false, some: "mixed", all: true } as const;
// A bigger target than the box, without moving it.
const ROW_CHECKBOX =
  "-m-1 p-1 focus-visible:ring-primary/50 disabled:opacity-50 disabled:cursor-default!";

interface Props {
  workspace: Workspace;
  /** Called after an invite from this tab, so the Invitations tab reads the new rows. */
  onInvitationsChanged?: () => void;
}

export default function WorkspaceGuestsTab(props: Props): React.ReactElement {
  const canManage = workspaceCan(props.workspace, "manage_members");
  // Permissions scope the returned notes; a change must discard the old list and open actions.
  return (
    <WorkspaceGuestsBody
      key={`${props.workspace.id}:${canManage}`}
      {...props}
      canManage={canManage}
    />
  );
}

function WorkspaceGuestsBody({
  workspace,
  onInvitationsChanged,
  canManage,
}: Props & { canManage: boolean }): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  // The parent body is keyed per workspace, so the hook only ever sees one id here.
  const { status, guests, error, reload, dropGuests, dropGuestNote } = useWorkspaceGuests(
    workspace.id
  );
  // One path for a row's menu and the selection bar: both hand the dialogs a list of guests.
  const [inviting, setInviting] = useState<WorkspaceGuest[] | null>(null);
  const [removing, setRemoving] = useState<WorkspaceGuest[] | null>(null);
  const [selection, setSelection] = useState<RowSelection>(() => new Set());
  const emails = guests.map((guest) => guest.email);
  const emailKey = emails.join("\n");
  const selectedGuests = guests.filter((guest) => selection.has(guest.email));
  const headerChecked = HEADER_CHECKED[headerCheckState(emails, selection)];

  // The bar acts on what is listed, so a reload that drops a guest drops it from the selection.
  useEffect(() => {
    setSelection((current) => keepRows(current, emails));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailKey]);
  // Invitations sent since the invite dialog opened, for the toast when it closes.
  const sentRef = useRef(0);
  const columnCount = canManage ? 4 : 2;
  const frameRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  // Set when focus was handed to the table as its last row went; the empty state takes it once
  // the list has emptied, since the table is gone by then.
  const refocusEmptyRef = useRef(false);
  const isEmpty = status === "ready" && guests.length === 0;

  useEffect(() => {
    if (isEmpty && refocusEmptyRef.current) emptyRef.current?.focus();
    refocusEmptyRef.current = false;
  }, [isEmpty]);

  const focusList = (): void => {
    if (emptyRef.current) {
      emptyRef.current.focus();
      return;
    }
    frameRef.current?.focus();
    refocusEmptyRef.current = true;
  };

  // Ends one guest's access to one note. Resolves true when the server removed it.
  const removeFromNote = async (guest: WorkspaceGuest, noteId: string): Promise<boolean> => {
    const target = guest.notes.find((note) => note.id === noteId);
    const names = {
      name: isolate(guestDisplayName(guest)),
      note: isolate(target?.title?.trim() ? target.title : t("notes.list.untitled")),
    };
    try {
      const result = await GuestsService.remove(workspace.id, {
        emails: [guest.email],
        note_id: noteId,
      });
      const email = guest.email.toLowerCase();
      if (!result.removed.some((removed) => removed.toLowerCase() === email)) {
        // Already gone or a member by now: the reload corrects the row without a false success.
        void reload();
        return false;
      }
      // Shown gone at once: the reload below can fail and would leave the note listed.
      dropGuestNote(guest.email, noteId);
      toast({
        title: t(`${KEY}.removedFromNote`, names),
        description:
          result.link_shared_note_ids.length > 0 ? t(`${KEY}.remove.linkShared`) : undefined,
      });
      void reload();
      return true;
    } catch (caught) {
      const failure = classifyRowActionError(caught);
      const workspaceName = isolate(workspace.name);
      if (
        caught instanceof CloudApiError &&
        caught.status === 404 &&
        caught.message === "Note not found"
      ) {
        // The note is already gone; the reload corrects the row.
        void reload();
        return false;
      }
      let title = t(`${KEY}.removeFromNoteFailed`, names);
      if (failure.kind === "refused") title = failure.message;
      else if (failure.kind === "notAllowed") {
        title = t("workspaces.removeMember.notAllowed", { workspace: workspaceName });
      } else if (failure.kind === "ssoRequired") {
        title = t("workspaces.ssoRequired", { workspace: workspaceName });
      }
      toast({ title, variant: "destructive" });
      return false;
    }
  };

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
      // Invited guests move to Invitations, so those are no longer there to act on.
      const invited = (inviting ?? []).map((guest) => guest.email);
      setSelection((current) => setRows(current, invited, false));
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
          initialEmails={inviting.map((guest) => guest.email)}
          heading={{
            title: t(`${KEY}.invite.title`, {
              count: inviting.length,
              workspace: isolate(workspace.name),
            }),
            description: t(`${KEY}.invite.description`, { workspace: isolate(workspace.name) }),
          }}
          onInvited={(emails) => {
            sentRef.current += emails.length;
          }}
          onInvitationsChanged={() => {
            void reload();
            onInvitationsChanged?.();
          }}
        />
      ) : null}
      {removing ? (
        <RemoveGuestsDialog
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          workspace={workspace}
          guests={removing}
          onRemoved={(result) => {
            // Shown gone at once: the reload below can fail and would leave them listed. With
            // nobody removed (all joined meanwhile) only the reload has anything to correct.
            if (result.removed.length > 0) dropGuests(result.removed);
            // A row's menu acts on one guest; the rest of the selection stays.
            const handled = removing.map((guest) => guest.email);
            setSelection((current) => setRows(current, handled, false));
            void reload();
          }}
        />
      ) : null}
    </>
  );

  const table = (
    <div className="space-y-4">
      <div
        ref={frameRef}
        tabIndex={-1}
        data-guests-table=""
        className={cn(TABLE_FRAME, "outline-none")}
      >
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {canManage ? (
              <>
                <col className="w-10" />
                <col className="w-[47%]" />
                <col className="w-[33%]" />
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
              {canManage ? (
                <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-0 text-start")}>
                  <RowCheckbox
                    label={t(`${KEY}.selection.selectAll`)}
                    checked={headerChecked}
                    className={ROW_CHECKBOX}
                    onToggle={() =>
                      setSelection((current) => setRows(current, emails, headerChecked !== true))
                    }
                  />
                </th>
              ) : null}
              <th
                scope="col"
                className={cn(HEADER_CELL, canManage ? "ps-3" : "ps-4", "pe-3 text-start")}
              >
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
                  selected={selection.has(guest.email)}
                  onToggle={() => setSelection((current) => toggleRow(current, guest.email))}
                  onRemoveFromNote={(noteId) => removeFromNote(guest, noteId)}
                  onTableFocus={focusList}
                  onInvite={() => setInviting([guest])}
                  onCopy={() => void copyEmail(guest)}
                  onRemove={() => setRemoving([guest])}
                />
              ))
            ) : (
              <tr className={ROW_DIVIDER}>
                <td colSpan={columnCount} className="px-4 py-8 text-center">
                  {status === "failed" ? (
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        {t(`${KEY}.failedTitle`)}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {error?.kind === "ssoRequired"
                          ? t("workspaces.ssoRequired", { workspace: isolate(workspace.name) })
                          : t(`${KEY}.failedBody`)}
                      </p>
                      {error?.kind === "ssoRequired" ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => void reload()}
                        >
                          {t("workspaces.exit.tryAgain")}
                        </Button>
                      )}
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
      {canManage ? (
        <SelectionBar
          count={selectedGuests.length}
          onClear={() => setSelection(new Set())}
          actions={[
            {
              id: "remove",
              label: t(`${KEY}.selection.remove`),
              tone: "destructive",
              onClick: () => setRemoving(selectedGuests),
            },
            {
              id: "invite",
              label: t(`${KEY}.selection.invite`),
              onClick: () => setInviting(selectedGuests),
            },
          ]}
        />
      ) : null}
    </div>
  );

  // The dialogs keep their place whether or not the list is empty, so inviting the last guests
  // doesn't remount the invite dialog and drop its Sent screen.
  return (
    <>
      {dialogs}
      {isEmpty ? <EmptyGuests ref={emptyRef} /> : table}
    </>
  );
}

function EmptyGuests({ ref }: { ref: React.Ref<HTMLDivElement> }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-guests-empty=""
      className="flex flex-col items-center px-6 py-14 text-center outline-none"
    >
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
  selected: boolean;
  onToggle: () => void;
  onRemoveFromNote: (noteId: string) => Promise<boolean>;
  onTableFocus: () => void;
  onInvite: () => void;
  onCopy: () => void;
  onRemove: () => void;
}

function GuestRow({
  guest,
  canManage,
  selected,
  onToggle,
  onRemoveFromNote,
  onTableFocus,
  onInvite,
  onCopy,
  onRemove,
}: GuestRowProps): React.ReactElement {
  const { t } = useTranslation();
  const hasName = guest.name?.trim();
  return (
    <tr className={cn("h-14", ROW_DIVIDER)}>
      {canManage ? (
        <td className="ps-4 pe-0">
          <RowCheckbox
            label={t(`settingsPage.workspace.people.selection.selectRow`, {
              name: isolate(guestDisplayName(guest)),
            })}
            checked={selected}
            className={ROW_CHECKBOX}
            onToggle={onToggle}
          />
        </td>
      ) : null}
      <td className={cn(canManage ? "ps-3" : "ps-4", "pe-3 max-w-0")}>
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
        <AccessCell
          guest={guest}
          canManage={canManage}
          onRemoveFromNote={onRemoveFromNote}
          onTableFocus={onTableFocus}
        />
      </td>
      {canManage ? (
        <td className="ps-3 pe-4 text-end">
          <RowMenu guest={guest} onInvite={onInvite} onCopy={onCopy} onRemove={onRemove} />
        </td>
      ) : null}
    </tr>
  );
}

function AccessCell({
  guest,
  canManage,
  onRemoveFromNote,
  onTableFocus,
}: Pick<
  GuestRowProps,
  "guest" | "canManage" | "onRemoveFromNote" | "onTableFocus"
>): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // Notes whose removal is in flight; a press on one of them does nothing.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const sendingRef = useRef(new Set<string>());
  // Completed requests update this immediately, including before React renders overlapping removals.
  const remainingNoteIdsRef = useRef(new Set(guest.notes.map((note) => note.id)));
  useEffect(() => {
    remainingNoteIdsRef.current = new Set(guest.notes.map((note) => note.id));
  }, [guest.notes]);
  // Set when the last note went: the row is leaving, so focus goes to the table, not the trigger.
  const emptiedRef = useRef(false);
  const label = t(`${KEY}.noteCount`, { count: guest.notes.length });
  const contentRef = useRef<HTMLDivElement>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // The note whose × takes focus once the removed one is gone from the list.
  const focusAfterRef = useRef<{ removed: string; next: string | undefined } | null>(null);

  // The × that held focus unmounts with its note; without this focus falls to <body> and the
  // menu stops answering arrow keys and Escape.
  useEffect(() => {
    const pending = focusAfterRef.current;
    if (!pending || guest.notes.some((note) => note.id === pending.removed)) return;
    focusAfterRef.current = null;
    const button = pending.next ? removeButtonRefs.current.get(pending.next) : undefined;
    (button ?? contentRef.current)?.focus();
  }, [guest.notes]);

  const removeNote = async (noteId: string): Promise<void> => {
    if (sendingRef.current.has(noteId)) return;
    sendingRef.current.add(noteId);
    setSending(new Set(sendingRef.current));
    // The row can unmount as soon as the removal lands, so the flag is set before it.
    const emptying = guest.notes.every((note) => note.id === noteId);
    if (emptying) emptiedRef.current = true;
    const index = guest.notes.findIndex((note) => note.id === noteId);
    const neighbour = guest.notes[index + 1] ?? guest.notes[index - 1];
    // Set before the request: the list can lose the note before the answer is read here.
    focusAfterRef.current = emptying ? null : { removed: noteId, next: neighbour?.id };
    const removed = await onRemoveFromNote(noteId);
    sendingRef.current.delete(noteId);
    setSending(new Set(sendingRef.current));
    if (!removed) {
      emptiedRef.current = false;
      focusAfterRef.current = null;
    } else {
      remainingNoteIdsRef.current.delete(noteId);
      if (remainingNoteIdsRef.current.size === 0) {
        emptiedRef.current = true;
        // Say where focus goes rather than leaving it to the menu's unmount: the row is gone.
        onTableFocus();
        setOpen(false);
      }
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={CONTACTS_TRIGGER}
        aria-label={t(`${KEY}.notesTriggerLabel`, {
          count: guest.notes.length,
          name: isolate(guestDisplayName(guest)),
        })}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        align="start"
        className="max-h-72 w-72 overflow-y-auto p-1.5"
        onCloseAutoFocus={(event) => {
          if (!emptiedRef.current) return;
          emptiedRef.current = false;
          event.preventDefault();
          onTableFocus();
        }}
      >
        {guest.notes.map((note) => {
          const title = note.title?.trim() ? note.title : t("notes.list.untitled");
          const isSending = sending.has(note.id);
          // A menu holds only items for a keyboard or screen reader, so a member's title is an
          // item that does nothing.
          if (!canManage) {
            return (
              <DropdownMenuItem
                key={note.id}
                className="gap-2.5 text-xs"
                onSelect={(event) => event.preventDefault()}
              >
                <FileText aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />
                <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">
                  {title}
                </span>
              </DropdownMenuItem>
            );
          }
          return (
            <div key={note.id} className="flex items-center gap-2.5 px-2 py-1.5">
              <FileText aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />
              <span dir="auto" className="min-w-0 flex-1 truncate text-xs text-foreground">
                {title}
              </span>
              <DropdownMenuItem
                asChild
                // On the item, not the button: asChild only concatenates the two class lists, so the
                // item's padding would win over the button's size and leave the icon no width.
                className="inline-flex size-5 shrink-0 cursor-default items-center justify-center rounded p-0 text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30 aria-disabled:opacity-60"
                onSelect={(event) => {
                  // Keep the menu open: the other notes are still listed.
                  event.preventDefault();
                  void removeNote(note.id);
                }}
              >
                <button
                  ref={(node) => {
                    if (node) removeButtonRefs.current.set(note.id, node);
                    else removeButtonRefs.current.delete(note.id);
                  }}
                  type="button"
                  aria-label={t(`${KEY}.removeFromNote`, { note: isolate(title) })}
                  aria-disabled={isSending}
                >
                  {isSending ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <X className="size-3" aria-hidden="true" />
                  )}
                </button>
              </DropdownMenuItem>
            </div>
          );
        })}
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
