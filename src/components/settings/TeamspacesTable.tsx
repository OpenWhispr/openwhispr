import React, { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FolderRounded, Loader2, MoreHorizontal, Plus, Trash2, Users } from "../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import MemberAvatar from "../MemberAvatar";
import { TileGlyph } from "../notes/SpaceNameField";
import { cn } from "../lib/utils";
import type { WorkspaceSpacesState } from "../../hooks/useWorkspaceSpaces";
import type { SpaceAdminContact, WorkspaceSpace } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

const NAME_TILE =
  "flex size-7 shrink-0 items-center justify-center rounded-sm bg-foreground/5 dark:bg-white/6";
const CONTACTS_TRIGGER =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border/70 px-2 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5 dark:border-border-subtle/70 dark:hover:bg-white/5";
const YOU_CHIP = "shrink-0 rounded px-1.5 py-px text-[10px] font-medium bg-primary/10 text-primary";

export interface TeamspacesTableUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface TeamspacesTableProps {
  status: WorkspaceSpacesState["status"];
  spaces: WorkspaceSpace[];
  /** The viewer may create teamspaces, so the table offers Actions where members get Members. */
  canCreate: boolean;
  /** Shown in the Members cell of a teamspace the viewer is in. */
  currentUser: TeamspacesTableUser | null;
  /** Teamspaces whose Join is running; each button reads Joining… on its own. */
  joiningIds: ReadonlySet<string>;
  /** Owner and admins of the workspace, listed where a teamspace has no admin of its own. */
  workspaceAdmins: SpaceAdminContact[];
  workspaceAdminsLoading: boolean;
  onWorkspaceAdminsOpen: () => void;
  onRetry: () => void;
  onCreate: () => void;
  onJoin: (space: WorkspaceSpace) => void;
  onOpen: (space: WorkspaceSpace) => void;
  onSettings: (space: WorkspaceSpace) => void;
  /** `actionsButton`: the row's menu button, where focus goes back if the delete is cancelled. */
  onDelete: (space: WorkspaceSpace, actionsButton: HTMLElement | null) => void;
}

export default function TeamspacesTable({
  status,
  spaces,
  canCreate,
  currentUser,
  joiningIds,
  workspaceAdmins,
  workspaceAdminsLoading,
  onWorkspaceAdminsOpen,
  onRetry,
  onCreate,
  onJoin,
  onOpen,
  onSettings,
  onDelete,
}: TeamspacesTableProps): React.ReactElement {
  const { t } = useTranslation();

  if (status === "ready" && spaces.length === 0) {
    return <EmptyTeamspaces canCreate={canCreate} onCreate={onCreate} />;
  }

  return (
    <div className={TABLE_FRAME}>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[46%]" />
          <col className="w-[27%]" />
          <col className="w-[27%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
              {t("settingsPage.workspace.teamspaces.columns.name")}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "px-3 text-start")}>
              {t("settingsPage.workspace.teamspaces.columns.admins")}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-start")}>
              {canCreate
                ? t("settingsPage.workspace.teamspaces.columns.actions")
                : t("settingsPage.workspace.teamspaces.columns.members")}
            </th>
          </tr>
        </thead>
        <tbody>
          {status === "ready" ? (
            spaces.map((space) => (
              <TeamspaceRow
                key={space.id}
                space={space}
                canCreate={canCreate}
                currentUser={currentUser}
                joining={joiningIds.has(space.id)}
                workspaceAdmins={workspaceAdmins}
                workspaceAdminsLoading={workspaceAdminsLoading}
                onWorkspaceAdminsOpen={onWorkspaceAdminsOpen}
                onJoin={onJoin}
                onOpen={onOpen}
                onSettings={onSettings}
                onDelete={onDelete}
              />
            ))
          ) : (
            <tr className={ROW_DIVIDER}>
              <td colSpan={3} className="px-4 py-8 text-center">
                {status === "failed" ? (
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      {t("settingsPage.workspace.teamspaces.failedTitle")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("settingsPage.workspace.teamspaces.failedBody")}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => onRetry()}>
                      {t("settingsPage.workspace.teamspaces.retry")}
                    </Button>
                  </div>
                ) : (
                  <div role="status">
                    <p className="text-xs font-medium text-foreground">
                      {t("settingsPage.workspace.teamspaces.loadingTitle")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("settingsPage.workspace.teamspaces.loadingBody")}
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

function EmptyTeamspaces({
  canCreate,
  onCreate,
}: {
  canCreate: boolean;
  onCreate: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-xl bg-surface-3 text-foreground/70"
      >
        <FolderRounded size={20} />
      </span>
      <p className="mt-4 text-sm font-medium text-foreground">
        {t("settingsPage.workspace.teamspaces.emptyTitle")}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {canCreate
          ? t("settingsPage.workspace.teamspaces.emptyBody")
          : t("settingsPage.workspace.teamspaces.emptyBodyMember")}
      </p>
      {canCreate && (
        <Button size="sm" className="mt-5" onClick={onCreate}>
          <Plus aria-hidden="true" />
          {t("settingsPage.workspace.teamspaces.create")}
        </Button>
      )}
    </div>
  );
}

// A person without a name is shown by address, which keeps its own left-to-right order inside a
// dir="auto" element.
function PersonLabel({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}): React.ReactElement | null {
  if (name) return <>{name}</>;
  return email ? <bdi dir="ltr">{email}</bdi> : null;
}

interface TeamspaceRowProps {
  space: WorkspaceSpace;
  canCreate: boolean;
  currentUser: TeamspacesTableUser | null;
  joining: boolean;
  workspaceAdmins: SpaceAdminContact[];
  workspaceAdminsLoading: boolean;
  onWorkspaceAdminsOpen: () => void;
  onJoin: (space: WorkspaceSpace) => void;
  onOpen: (space: WorkspaceSpace) => void;
  onSettings: (space: WorkspaceSpace) => void;
  onDelete: (space: WorkspaceSpace, actionsButton: HTMLElement | null) => void;
}

function TeamspaceRow({
  space,
  canCreate,
  currentUser,
  joining,
  workspaceAdmins,
  workspaceAdminsLoading,
  onWorkspaceAdminsOpen,
  onJoin,
  onOpen,
  onSettings,
  onDelete,
}: TeamspaceRowProps): React.ReactElement {
  const { t } = useTranslation();
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  // A directory from before release 5 sends no my_role, which reads as no access.
  const belongs = space.my_role != null;
  // The Members cell is where a member's own row lives, so that layout opens its settings.
  const opensSettings = !canCreate && belongs;
  // The cells that hold their own controls must not also count as a click on the row.
  const stopRowClick = (event: React.MouseEvent): void => event.stopPropagation();

  return (
    <tr
      className={cn(
        "h-14",
        ROW_DIVIDER,
        opensSettings && "cursor-pointer transition-colors hover:bg-foreground/3"
      )}
      onClick={opensSettings ? () => onSettings(space) : undefined}
    >
      <td className="ps-4 pe-3 max-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className={NAME_TILE}>
            <TileGlyph emoji={space.emoji} name={space.name} />
          </span>
          {opensSettings ? (
            // A real button, so the keyboard reaches the row; its click bubbles to the row.
            <button
              type="button"
              dir="auto"
              className="min-w-0 truncate rounded-sm text-start text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              {space.name}
            </button>
          ) : (
            <span dir="auto" className="min-w-0 truncate text-xs font-medium text-foreground">
              {space.name}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 max-w-0" onClick={stopRowClick}>
        <AdminsCell
          admins={space.admins ?? []}
          workspaceAdmins={workspaceAdmins}
          workspaceAdminsLoading={workspaceAdminsLoading}
          onWorkspaceAdminsOpen={onWorkspaceAdminsOpen}
        />
      </td>
      {canCreate ? (
        <td className="ps-3 pe-4" onClick={stopRowClick}>
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={actionsButtonRef}
              aria-label={t("settingsPage.workspace.teamspaces.rowMenu.label", {
                name: isolate(space.name),
              })}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/30 data-[state=open]:bg-foreground/5 dark:hover:bg-white/5"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem className="text-xs" onSelect={() => onOpen(space)}>
                {t("settingsPage.workspace.teamspaces.openTeamspace")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onSelect={() => onSettings(space)}>
                {t("settingsPage.workspace.teamspaces.rowMenu.settings")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs text-destructive focus:text-destructive"
                onSelect={() => onDelete(space, actionsButtonRef.current)}
              >
                <Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t("settingsPage.workspace.teamspaces.rowMenu.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      ) : (
        <td className="ps-3 pe-4 max-w-0">
          {belongs ? (
            <div className="flex min-w-0 items-center gap-2">
              <MemberAvatar
                name={currentUser?.name ?? null}
                email={currentUser?.email ?? null}
                image={currentUser?.image}
                size="sm"
              />
              <span dir="auto" className="min-w-0 truncate text-xs text-foreground">
                <PersonLabel name={currentUser?.name} email={currentUser?.email} />
              </span>
              <span className={YOU_CHIP}>{t("settingsPage.workspace.teamspaces.you")}</span>
            </div>
          ) : (
            space.can_join === true && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-3"
                disabled={joining}
                onClick={() => onJoin(space)}
              >
                {joining && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
                {joining
                  ? t("settingsPage.workspace.teamspaces.joining")
                  : t("settingsPage.workspace.teamspaces.join")}
              </Button>
            )
          )}
        </td>
      )}
    </tr>
  );
}

interface AdminsCellProps {
  admins: SpaceAdminContact[];
  workspaceAdmins: SpaceAdminContact[];
  workspaceAdminsLoading: boolean;
  onWorkspaceAdminsOpen: () => void;
}

function AdminsCell({
  admins,
  workspaceAdmins,
  workspaceAdminsLoading,
  onWorkspaceAdminsOpen,
}: AdminsCellProps): React.ReactElement {
  const { t } = useTranslation();

  if (admins.length === 1) {
    const [admin] = admins;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <MemberAvatar name={admin.name} email={admin.email} image={admin.image} size="sm" />
        <span dir="auto" className="min-w-0 truncate text-xs text-foreground">
          <PersonLabel name={admin.name} email={admin.email} />
        </span>
      </div>
    );
  }

  if (admins.length > 1) {
    return (
      <ContactsMenu
        label={t("settingsPage.workspace.teamspaces.adminCount", { count: admins.length })}
        contacts={admins}
      />
    );
  }

  // Nobody to ask in this teamspace, so the people who can reach it anyway stand in. Their roster
  // is read when the menu opens, since this page doesn't otherwise need it.
  return (
    <ContactsMenu
      label={t("settingsPage.workspace.teamspaces.noAdmins")}
      contacts={workspaceAdmins}
      loading={workspaceAdminsLoading}
      onOpen={onWorkspaceAdminsOpen}
    />
  );
}

interface ContactsMenuProps {
  label: string;
  contacts: SpaceAdminContact[];
  loading?: boolean;
  onOpen?: () => void;
}

function ContactsMenu({
  label,
  contacts,
  loading = false,
  onOpen,
}: ContactsMenuProps): React.ReactElement {
  return (
    <Popover onOpenChange={(open) => open && onOpen?.()}>
      <PopoverTrigger className={CONTACTS_TRIGGER}>
        <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      {(contacts.length > 0 || loading) && (
        <PopoverContent align="start" className="w-64 p-1.5">
          {contacts.length === 0 ? (
            <div role="status" className="flex justify-center py-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : (
            <ul className="flex flex-col">
              {contacts.map((contact) => (
                <li key={contact.user_id} className="flex items-center gap-2.5 px-2 py-1.5">
                  <MemberAvatar
                    name={contact.name}
                    email={contact.email}
                    image={contact.image}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <p dir="auto" className="truncate text-xs font-medium text-foreground">
                      <PersonLabel name={contact.name} email={contact.email} />
                    </p>
                    {contact.name && (
                      <p className="truncate text-[11px] text-muted-foreground">
                        <bdi dir="ltr">{contact.email}</bdi>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
