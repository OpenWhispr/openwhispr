import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, FolderRounded, Loader2, Plus } from "../icons";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import MemberAvatar from "../MemberAvatar";
import { TeamGlyph } from "../workspace/TeamGlyph";
import { RowCheckbox } from "../dictionary/RowCheckbox";
import { EmptyStateArt } from "../workspace/EmptyStateArt";
import { SelectionBar } from "../workspace/SelectionBar";
import { EMPTY_CREATE_BUTTON } from "../workspace/dialogButtons";
import { cn } from "../lib/utils";
import { isolate } from "../../utils/bidiIsolate";
import { TeamsService } from "../../services/TeamsService";
import type { WorkspaceTeamsState } from "../../hooks/useWorkspaceTeams";
import {
  headerCheckState,
  keepRows,
  setRows,
  toggleRow,
  type RowSelection,
} from "../../lib/rowSelection";
import type { Team, TeamMember } from "../../types/electron";
import {
  COLUMN_DIVIDER,
  CONTACTS_TRIGGER,
  HEADER_CELL,
  NAME_TILE,
  ROW_DIVIDER,
  TABLE_FRAME,
} from "./tableTokens";

interface TeamsTableProps {
  status: WorkspaceTeamsState["status"];
  teams: Team[];
  /** The viewer may start a team, so the empty state offers Create where members read a note. */
  canCreate: boolean;
  /** Whoever manages teams gets a checkbox column, as the design draws it for admins. */
  selectable?: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onOpen: (team: Team) => void;
}

const HEADER_CHECKED = { none: false, some: "mixed", all: true } as const;

export default function TeamsTable({
  status,
  teams,
  canCreate,
  selectable = false,
  onRetry,
  onCreate,
  onOpen,
}: TeamsTableProps): React.ReactElement {
  const { t } = useTranslation();
  const [selection, setSelection] = useState<RowSelection>(() => new Set());
  const teamIds = teams.map((team) => team.id);
  const teamKey = teamIds.join(",");
  // A team that left the list (deleted, or left by the viewer) leaves the selection too.
  useEffect(() => {
    setSelection((current) => keepRows(current, teamIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey]);

  if (status === "ready" && teams.length === 0) {
    return <EmptyTeams canCreate={canCreate} onCreate={onCreate} />;
  }

  const headerChecked = HEADER_CHECKED[headerCheckState(teamIds, selection)];
  const columnCount = selectable ? 4 : 3;

  return (
    <>
      <div className={TABLE_FRAME}>
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {selectable ? <col className="w-11" /> : null}
            <col className={selectable ? "w-[48%]" : "w-[55%]"} />
            <col className="w-[24%]" />
            <col className={selectable ? "w-[20%]" : "w-[21%]"} />
          </colgroup>
          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className={cn(HEADER_CELL, "px-3 text-start")}>
                  {teamIds.length > 0 ? (
                    <RowCheckbox
                      label={t("settingsPage.workspace.teams.selectAll")}
                      checked={headerChecked}
                      className="-m-1 p-1 focus-visible:ring-primary/50"
                      onToggle={() =>
                        setSelection((current) => setRows(current, teamIds, headerChecked !== true))
                      }
                    />
                  ) : null}
                </th>
              ) : null}
              <th
                scope="col"
                className={cn(HEADER_CELL, "px-3 text-start", selectable ? COLUMN_DIVIDER : "ps-4")}
              >
                {t("settingsPage.workspace.teams.columns.name")}
              </th>
              <th scope="col" className={cn(HEADER_CELL, COLUMN_DIVIDER, "px-3 text-start")}>
                {t("settingsPage.workspace.teams.columns.members")}
              </th>
              <th scope="col" className={cn(HEADER_CELL, COLUMN_DIVIDER, "ps-3 pe-4 text-start")}>
                {t("settingsPage.workspace.teams.columns.teamspaces")}
              </th>
            </tr>
          </thead>
          <tbody>
            {status === "ready" ? (
              teams.map((team) => (
                <TeamRow
                  key={team.id}
                  team={team}
                  onOpen={onOpen}
                  selectable={selectable}
                  selected={selection.has(team.id)}
                  onToggle={() => setSelection((current) => toggleRow(current, team.id))}
                />
              ))
            ) : (
              <tr className={ROW_DIVIDER}>
                <td colSpan={columnCount} className="px-4 py-8 text-center">
                  {status === "failed" ? (
                    <div>
                      <p className="text-xs font-medium text-foreground">
                        {t("settingsPage.workspace.teams.failedTitle")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("settingsPage.workspace.teams.failedBody")}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => onRetry()}
                      >
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
      {selectable ? (
        <SelectionBar count={selection.size} onClear={() => setSelection(new Set())} actions={[]} />
      ) : null}
    </>
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
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <EmptyStateArt kind="teams" />
      <p className="mt-2 text-lg font-medium leading-[1.4] text-foreground">
        {t("settingsPage.workspace.teams.emptyTitle")}
      </p>
      <p className="mt-1.5 max-w-[339px] text-sm text-muted-foreground">
        {canCreate
          ? t("settingsPage.workspace.teams.emptyBody")
          : t("settingsPage.workspace.teams.emptyBodyMember")}
      </p>
      {canCreate && (
        <button type="button" className={cn(EMPTY_CREATE_BUTTON, "mt-5")} onClick={onCreate}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("settingsPage.workspace.teams.create")}
        </button>
      )}
    </div>
  );
}

function TeamRow({
  team,
  onOpen,
  selectable,
  selected,
  onToggle,
}: {
  team: Team;
  onOpen: (team: Team) => void;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  // The cells that hold their own menus must not also count as a click on the row.
  const stopRowClick = (event: React.MouseEvent): void => event.stopPropagation();

  return (
    <tr
      className={cn("h-12 cursor-pointer transition-colors hover:bg-foreground/3", ROW_DIVIDER)}
      onClick={() => onOpen(team)}
    >
      {selectable ? (
        <td className="px-3" onClick={stopRowClick}>
          <RowCheckbox
            label={t("settingsPage.workspace.teams.selectRow", { name: isolate(team.name) })}
            checked={selected}
            className="-m-1 p-1 focus-visible:ring-primary/50"
            onToggle={onToggle}
          />
        </td>
      ) : null}
      <td className={cn("pe-3 max-w-0", selectable ? cn(COLUMN_DIVIDER, "ps-3") : "ps-4")}>
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className={NAME_TILE}>
            <TeamGlyph emoji={team.emoji} name={team.name} />
          </span>
          {/* A real button, so the keyboard reaches the row; its click bubbles to the row. */}
          <button
            type="button"
            dir="auto"
            className="min-w-0 truncate rounded-sm text-start text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            {team.name}
          </button>
        </div>
      </td>
      <td className={cn(COLUMN_DIVIDER, "px-3 max-w-0")} onClick={stopRowClick}>
        <MembersCell team={team} />
      </td>
      <td className={cn(COLUMN_DIVIDER, "ps-3 pe-4 max-w-0")} onClick={stopRowClick}>
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
