import React from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceGuests } from "../../hooks/useWorkspaceGuests";
import { guestDisplayName } from "../../lib/guestsView";
import { isolate } from "../../utils/bidiIsolate";
import { ChevronDown, FileText, Users } from "../icons";
import MemberAvatar from "../MemberAvatar";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
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
  const { status, guests, reload } = useWorkspaceGuests(workspace.id);

  if (status === "ready" && guests.length === 0) return <EmptyGuests />;

  return (
    <div className={TABLE_FRAME}>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[55%]" />
          <col className="w-[45%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
              {t(`${KEY}.columns.name`)}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-start")}>
              {t(`${KEY}.columns.access`)}
            </th>
          </tr>
        </thead>
        <tbody>
          {status === "ready" ? (
            guests.map((guest) => <GuestRow key={guest.email} guest={guest} />)
          ) : (
            <tr className={ROW_DIVIDER}>
              <td colSpan={2} className="px-4 py-8 text-center">
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

function GuestRow({ guest }: { guest: WorkspaceGuest }): React.ReactElement {
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
