import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatList } from "../../lib/formatList";
import type { SpaceMemberRow } from "../../lib/spaceMemberRows";
import type { TeamRole } from "../../types/electron";
import { isolate } from "../../utils/bidiIsolate";
import { EnvelopePlus } from "../icons";
import { cn } from "../lib/utils";
import MemberAvatar from "../MemberAvatar";
import { COLUMN_DIVIDER, HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "../settings/tableTokens";
import { Button } from "../ui/button";
import { TileGlyph } from "./SpaceNameField";
import { SpaceRoleMenu, type SpaceRoleMenuCopy } from "./SpaceRoleMenu";

// Seven rows fit with the header; a longer list scrolls inside the table, and on a short window
// the cap shrinks so the dialog around it never has to scroll as a whole.
const ROWS_SCROLLER = "max-h-[clamp(9rem,calc(85vh-25rem),22rem)] overflow-y-auto";
const TILE =
  "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 text-primary";

const TEAM_ACCESS_TRIGGER: Record<TeamRole, string> = {
  member: "settingsPage.workspace.teamspaces.members.teamAccessMemberShort",
  admin: "settingsPage.workspace.teamspaces.members.teamAccessAdminShort",
};

// A team's access: Admin makes the team's own admins admins here, never everyone on the team.
const TEAM_ACCESS_COPY: SpaceRoleMenuCopy = {
  roleMember: "settingsPage.workspace.teamspaces.members.teamAccessMember",
  roleMemberBody: "settingsPage.workspace.teamspaces.members.teamAccessMemberBody",
  roleAdmin: "settingsPage.workspace.teamspaces.members.teamAccessAdmin",
  roleAdminBody: "settingsPage.workspace.teamspaces.members.teamAccessAdminBody",
  remove: "settingsPage.workspace.teamspaces.members.removeItem",
  trigger: TEAM_ACCESS_TRIGGER,
};

export type SpaceMembersStatus = "loading" | "failed" | "ready";

interface SpaceMembersTableProps {
  status: SpaceMembersStatus;
  rows: SpaceMemberRow[];
  /** A team's emoji, from the workspace's teams; the teamspace's own refs carry none. */
  teamEmoji: ReadonlyMap<string, string | null>;
  /** Names the table for screen readers, which can't see the dialog's heading from inside it. */
  label: string;
  /** Teams carry no flag of their own, so whether their access can be changed comes from here. */
  canManage: boolean;
  /** Rows with a change in flight. */
  pendingIds: ReadonlySet<string>;
  onRetry: () => void;
  onRoleChange: (row: SpaceMemberRow, role: TeamRole) => void;
  onRemove: (row: SpaceMemberRow) => void;
}

export function SpaceMembersTable({
  status,
  rows,
  teamEmoji,
  label,
  canManage,
  pendingIds,
  onRetry,
  onRoleChange,
  onRemove,
}: SpaceMembersTableProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className={cn(TABLE_FRAME, "overflow-hidden")}>
      {/* Focusable, so the keyboard can scroll it when no row holds a control (a plain member). */}
      <div
        tabIndex={0}
        role="region"
        aria-label={label}
        className={cn(
          ROWS_SCROLLER,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        )}
      >
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[62%]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
                {t("settingsPage.workspace.teamspaces.columns.name")}
              </th>
              <th scope="col" className={cn(HEADER_CELL, COLUMN_DIVIDER, "px-4 text-start")}>
                {t("settingsPage.workspace.teamspaces.members.columnRole")}
              </th>
            </tr>
          </thead>
          <tbody>
            {status === "ready" && rows.length > 0 ? (
              rows.map((row) => (
                <MemberRow
                  key={row.id}
                  row={row}
                  teamEmoji={teamEmoji}
                  canManage={canManage}
                  pending={pendingIds.has(row.id)}
                  onRoleChange={onRoleChange}
                  onRemove={onRemove}
                />
              ))
            ) : (
              <tr className={ROW_DIVIDER}>
                <td colSpan={2} className="px-4 py-8 text-center">
                  <TableMessage status={status} onRetry={onRetry} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableMessage({
  status,
  onRetry,
}: {
  status: SpaceMembersStatus;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (status === "failed") {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.workspace.members.loadError")}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("settingsPage.workspace.loadError.retry")}
        </Button>
      </div>
    );
  }
  if (status === "loading") {
    return <div aria-hidden="true" className="h-10 animate-pulse rounded-lg bg-foreground/5" />;
  }
  return <p className="text-xs text-muted-foreground">{t("notes.spaces.members.empty")}</p>;
}

interface MemberRowProps {
  row: SpaceMemberRow;
  teamEmoji: ReadonlyMap<string, string | null>;
  canManage: boolean;
  pending: boolean;
  onRoleChange: (row: SpaceMemberRow, role: TeamRole) => void;
  onRemove: (row: SpaceMemberRow) => void;
}

function MemberRow({
  row,
  teamEmoji,
  canManage,
  pending,
  onRoleChange,
  onRemove,
}: MemberRowProps): ReactElement {
  const { t, i18n } = useTranslation();
  const roleLabel = (role: TeamRole): string =>
    role === "admin" ? t("notes.spaces.members.roleAdmin") : t("notes.spaces.members.roleMember");

  let name: ReactElement;
  let role: ReactNode;

  if (row.kind === "person" || row.kind === "inherited") {
    const { member } = row;
    const displayName = member.name || member.email;
    name = (
      <NameCell
        lead={
          <MemberAvatar name={member.name} email={member.email} image={member.image} size="row" />
        }
        primary={
          member.name ? <span dir="auto">{member.name}</span> : <bdi dir="ltr">{member.email}</bdi>
        }
        secondary={
          row.kind === "inherited" ? (
            <>
              <bdi dir="ltr">{member.email}</bdi> · <span dir="auto">{row.teamName}</span>
            </>
          ) : member.name ? (
            <bdi dir="ltr">{member.email}</bdi>
          ) : null
        }
      />
    );
    if (row.kind === "inherited" && row.promotable) {
      role = (
        <SpaceRoleMenu
          role={member.role}
          subject={displayName}
          pending={pending}
          onRoleChange={(next) => onRoleChange(row, next)}
        />
      );
    } else if (row.kind === "inherited") {
      // The teams are already named under the person, so the cell holds the role alone; the
      // whole "via" line stays on hover.
      role = (
        <span
          className="text-sm text-foreground"
          title={t(
            row.asAdmin
              ? "settingsPage.workspace.teamspaces.members.viaAdmin"
              : "settingsPage.workspace.teamspaces.members.via",
            { team: row.teamName }
          )}
        >
          {roleLabel(member.role)}
        </span>
      );
    } else if (row.editable) {
      role = (
        <SpaceRoleMenu
          role={member.role}
          subject={displayName}
          pending={pending}
          onRoleChange={(next) => onRoleChange(row, next)}
          onRemove={() => onRemove(row)}
          adminThrough={
            row.adminVia.length > 0
              ? formatList(i18n.language, row.adminVia.map(isolate))
              : undefined
          }
        />
      );
    } else {
      role = <RoleText>{roleLabel(member.role)}</RoleText>;
    }
  } else if (row.kind === "invitation") {
    name = (
      <NameCell
        lead={
          <span className={TILE}>
            <EnvelopePlus className="size-3" aria-hidden="true" />
          </span>
        }
        primary={<bdi dir="ltr">{row.invitation.email}</bdi>}
        secondary={
          row.invitation.workspace_role === "admin"
            ? t("settingsPage.workspace.teamspaces.members.invitationPendingAdmin")
            : t("settingsPage.workspace.teamspaces.members.invitationPending")
        }
      />
    );
    role = <RoleText>{roleLabel(row.invitation.role)}</RoleText>;
  } else {
    const { team } = row;
    name = (
      <NameCell
        lead={
          <span className={cn(TILE, "[&>span]:text-xs [&>span]:text-primary")}>
            <TileGlyph emoji={teamEmoji.get(team.id) ?? null} name={team.name} />
          </span>
        }
        primary={<span dir="auto">{team.name}</span>}
        secondary={
          team.memberCount != null
            ? t("settingsPage.workspace.teamspaces.picker.teamPeople", { count: team.memberCount })
            : null
        }
      />
    );
    role = canManage ? (
      <SpaceRoleMenu
        role={team.access}
        subject={team.name}
        pending={pending}
        onRoleChange={(next) => onRoleChange(row, next)}
        onRemove={() => onRemove(row)}
        copy={TEAM_ACCESS_COPY}
      />
    ) : (
      <RoleText>{t(TEAM_ACCESS_TRIGGER[team.access])}</RoleText>
    );
  }

  return (
    <tr className={cn("h-14", ROW_DIVIDER)}>
      <td className="max-w-0 ps-4 pe-3 py-1.5">{name}</td>
      <td className={cn(COLUMN_DIVIDER, "px-4")}>{role}</td>
    </tr>
  );
}

function RoleText({ children }: { children: ReactNode }): ReactElement {
  return <span className="text-sm text-foreground">{children}</span>;
}

function NameCell({
  lead,
  primary,
  secondary,
}: {
  lead: ReactNode;
  primary: ReactNode;
  secondary: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="flex shrink-0">
        {lead}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs text-foreground">{primary}</span>
        {secondary ? (
          <span className="truncate text-xs text-muted-foreground">{secondary}</span>
        ) : null}
      </span>
    </div>
  );
}
