import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FolderRounded, Loader2, Plus, Users } from "../icons";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import MemberAvatar from "../MemberAvatar";
import { TileGlyph } from "../notes/SpaceNameField";
import { cn } from "../lib/utils";
import { isolate } from "../../utils/bidiIsolate";
import { TeamsService } from "../../services/TeamsService";
import type { WorkspaceTeamsState } from "../../hooks/useWorkspaceTeams";
import type { Team, TeamMember } from "../../types/electron";
import { CONTACTS_TRIGGER, HEADER_CELL, NAME_TILE, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

interface TeamsTableProps {
  status: WorkspaceTeamsState["status"];
  teams: Team[];
  /** The viewer may start a team, so the empty state offers Create where members read a note. */
  canCreate: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (team: Team) => void;
}

export default function TeamsTable({
  status,
  teams,
  canCreate,
  onRetry,
  onCreate,
  onOpen,
}: TeamsTableProps): React.ReactElement {
  const { t } = useTranslation();

  if (status === "ready" && teams.length === 0) {
    return <EmptyTeams canCreate={canCreate} onCreate={onCreate} />;
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
              {t("settingsPage.workspace.teams.columns.name")}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "px-3 text-start")}>
              {t("settingsPage.workspace.teams.columns.members")}
            </th>
            <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-start")}>
              {t("settingsPage.workspace.teams.columns.teamspaces")}
            </th>
          </tr>
        </thead>
        <tbody>
          {status === "ready" ? (
            teams.map((team) => <TeamRow key={team.id} team={team} onOpen={onOpen} />)
          ) : (
            <tr className={ROW_DIVIDER}>
              <td colSpan={3} className="px-4 py-8 text-center">
                {status === "failed" ? (
                  <div>
                    <p className="text-xs font-medium text-foreground">
                      {t("settingsPage.workspace.teams.failedTitle")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("settingsPage.workspace.teams.failedBody")}
                    </p>
                    <Button variant="outline" size="sm" className="mt-3" onClick={() => onRetry()}>
                      {t("settingsPage.workspace.teams.retry")}
                    </Button>
                  </div>
                ) : (
                  <div role="status">
                    <p className="text-xs font-medium text-foreground">
                      {t("settingsPage.workspace.teams.loadingTitle")}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("settingsPage.workspace.teams.loadingBody")}
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

function EmptyTeams({
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
        <Users size={20} />
      </span>
      <p className="mt-4 text-sm font-medium text-foreground">
        {t("settingsPage.workspace.teams.emptyTitle")}
      </p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {canCreate
          ? t("settingsPage.workspace.teams.emptyBody")
          : t("settingsPage.workspace.teams.emptyBodyMember")}
      </p>
      {canCreate && (
        <Button size="sm" className="mt-5" onClick={onCreate}>
          <Plus aria-hidden="true" />
          {t("settingsPage.workspace.teams.create")}
        </Button>
      )}
    </div>
  );
}

function TeamRow({
  team,
  onOpen,
}: {
  team: Team;
  onOpen: (team: Team) => void;
}): React.ReactElement {
  // The cells that hold their own menus must not also count as a click on the row.
  const stopRowClick = (event: React.MouseEvent): void => event.stopPropagation();

  return (
    <tr
      className={cn("h-14 cursor-pointer transition-colors hover:bg-foreground/3", ROW_DIVIDER)}
      onClick={() => onOpen(team)}
    >
      <td className="ps-4 pe-3 max-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className={NAME_TILE}>
            {team.emoji ? (
              <TileGlyph emoji={team.emoji} name={team.name} />
            ) : (
              <Users className="size-3.5 text-muted-foreground" />
            )}
          </span>
          {/* A real button, so the keyboard reaches the row; its click bubbles to the row. */}
          <button
            type="button"
            dir="auto"
            className="min-w-0 truncate rounded-sm text-start text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            {team.name}
          </button>
        </div>
      </td>
      <td className="px-3 max-w-0" onClick={stopRowClick}>
        <MembersCell team={team} />
      </td>
      <td className="ps-3 pe-4 max-w-0" onClick={stopRowClick}>
        <SpacesCell teamName={team.name} spaces={team.spaces ?? []} />
      </td>
    </tr>
  );
}

type RosterState =
  | { status: "idle" }
  | { status: "loading"; members: TeamMember[] | null }
  | { status: "failed" }
  | { status: "ready"; members: TeamMember[] };

// The roster is read when the list opens, since the table only has the count.
function MembersCell({ team }: { team: Team }): React.ReactElement {
  const { t } = useTranslation();
  const [roster, setRoster] = useState<RosterState>({ status: "idle" });
  const latestRead = useRef(0);
  const count = team.member_count ?? 0;

  const read = useCallback(async (): Promise<void> => {
    const readId = ++latestRead.current;
    setRoster((current) => ({
      status: "loading",
      members: current.status === "ready" ? current.members : null,
    }));
    try {
      const members = await TeamsService.listMembers(team.id);
      if (latestRead.current === readId) setRoster({ status: "ready", members });
    } catch {
      if (latestRead.current === readId) setRoster({ status: "failed" });
    }
  }, [team.id]);

  const label = t("settingsPage.workspace.teams.people", { count });
  if (count === 0) return <span className="text-xs text-muted-foreground">{label}</span>;

  return (
    <Popover onOpenChange={(open) => open && void read()}>
      <PopoverTrigger
        className={CONTACTS_TRIGGER}
        aria-label={t("settingsPage.workspace.teams.cellMenuLabel", {
          team: isolate(team.name),
          value: label,
        })}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {roster.status === "failed" ? (
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.workspace.teams.failedBody")}
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void read()}>
              {t("settingsPage.workspace.teams.retry")}
            </Button>
          </div>
        ) : roster.status === "ready" || (roster.status === "loading" && roster.members) ? (
          <ul className="flex flex-col">
            {(roster.status === "ready" ? roster.members : (roster.members ?? [])).map((member) => (
              <li key={member.user_id} className="flex items-center gap-2.5 px-2 py-1.5">
                <MemberAvatar
                  name={member.name}
                  email={member.email}
                  image={member.image}
                  size="sm"
                />
                <div className="min-w-0">
                  <p dir="auto" className="truncate text-xs font-medium text-foreground">
                    {member.name ? member.name : <bdi dir="ltr">{member.email}</bdi>}
                  </p>
                  {member.name && (
                    <p className="truncate text-[11px] text-muted-foreground">
                      <bdi dir="ltr">{member.email}</bdi>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div role="status" className="flex justify-center py-2">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

type TeamSpaces = NonNullable<Team["spaces"]>;

function SpaceGlyph({ emoji }: { emoji: string | null }): React.ReactElement {
  return emoji ? (
    <span aria-hidden="true" className="font-emoji text-sm leading-none">
      {emoji}
    </span>
  ) : (
    <FolderRounded aria-hidden="true" size={14} className="text-muted-foreground" />
  );
}

function SpacesCell({
  teamName,
  spaces,
}: {
  teamName: string;
  spaces: TeamSpaces;
}): React.ReactElement {
  const { t } = useTranslation();
  const label = t("settingsPage.workspace.teams.spaces", { count: spaces.length });

  if (spaces.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("settingsPage.workspace.teams.spacesNone")}
      </span>
    );
  }

  if (spaces.length === 1) {
    const [space] = spaces;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <SpaceGlyph emoji={space.emoji} />
        <span dir="auto" className="min-w-0 truncate text-xs text-foreground">
          {space.name}
        </span>
      </div>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        className={CONTACTS_TRIGGER}
        aria-label={t("settingsPage.workspace.teams.cellMenuLabel", {
          team: isolate(teamName),
          value: label,
        })}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <ul className="flex flex-col">
          {spaces.map((space) => (
            <li key={space.id} className="flex items-center gap-2.5 px-2 py-1.5">
              <SpaceGlyph emoji={space.emoji} />
              <span dir="auto" className="min-w-0 truncate text-xs text-foreground">
                {space.name}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
