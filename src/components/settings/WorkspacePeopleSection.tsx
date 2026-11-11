import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { ChevronDown, Plus, Search, User, UserCircle, UserPlus, Users, X } from "../icons";
import type { IconComponent } from "../icons";
import { teamCreationFor, workspaceCan } from "../../lib/capabilities";
import { invitationStatus, rosterFor } from "../../lib/peopleRoster";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace } from "../../types/electron";
import InviteTeammateDialog from "../InviteTeammateDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import WorkspaceInvitationsTab from "./WorkspaceInvitationsTab";
import WorkspaceGuestsTab from "./WorkspaceGuestsTab";
import WorkspaceMembersTab from "./WorkspaceMembersTab";
import WorkspaceTeamsTab from "./WorkspaceTeamsTab";
import { ESCAPE_CLEARS_ATTRIBUTE } from "../ui/escapeClears";
import { Input } from "../ui/input";
import {
  RAISED_PILL,
  SPLIT_PILL,
  SPLIT_PILL_CHEVRON,
  SPLIT_PILL_LABEL,
} from "../workspace/dialogButtons";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { PAGE_DESCRIPTION, PAGE_TITLE } from "./tableTokens";
import { useSettingsWorkspace } from "./useSettingsWorkspace";
import { useWorkspaceInvitations } from "./useWorkspaceInvitations";

const PEOPLE_TABS = ["members", "invitations", "guests", "teams"] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number];

// Figma reuses user-plus for Guests as well as Invitations; Guests deliberately gets a lone person
// instead, so the two tabs don't read as the same thing.
const TAB_ICONS: Record<PeopleTab, IconComponent> = {
  members: UserCircle,
  invitations: UserPlus,
  guests: User,
  teams: Users,
};

const PEOPLE_TAB_KEY = "settings.workspacePeopleTab";
// The single Workspace page kept its tab here; a Members or Teams choice carries over once.
const LEGACY_WORKSPACE_TAB_KEY = "settings.workspaceTab";

function isPeopleTab(value: unknown): value is PeopleTab {
  return PEOPLE_TABS.includes(value as PeopleTab);
}

function legacyPeopleTab(): PeopleTab | null {
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACE_TAB_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isPeopleTab(value) ? value : null;
  } catch {
    return null;
  }
}

interface Props {
  initialSubTab?: string;
  onOpenTeamspace?: (localSpaceId: number) => void;
}

interface BodyProps {
  workspace: Workspace;
  storedTab: string;
  onSelectTab: (tab: PeopleTab) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onOpenTeamspace?: (localSpaceId: number) => void;
}

function PeopleBody({
  workspace,
  storedTab,
  onSelectTab,
  searchQuery,
  onSearchQueryChange,
  onOpenTeamspace,
}: BodyProps): React.ReactElement {
  const { t } = useTranslation();
  const canManage = workspaceCan(workspace, "manage_members");
  const invitations = useWorkspaceInvitations(workspace.id, canManage);
  const { roster, rosterIsOurs, refreshMembers } = useWorkspaceStore(
    useShallow((state) => ({
      roster: rosterFor(state, workspace.id),
      rosterIsOurs: state.membersWorkspaceId === workspace.id,
      refreshMembers: state.refreshMembers,
    }))
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  // Create team from the Add menu: the Teams tab opens and its opener answers, once.
  const [createRequested, setCreateRequested] = useState(false);
  const [teamsEmpty, setTeamsEmpty] = useState(false);
  const invitedCountRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const clearSearch = useCallback((): void => {
    onSearchQueryChange("");
    searchInputRef.current?.focus();
  }, [onSearchQueryChange]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // An empty field leaves Escape alone so it can still close the Settings dialog.
    if (event.key !== "Escape" || !searchQuery) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  };

  // Without the capability the stored choice only reads as Members; it isn't overwritten, so a
  // member who later becomes an admin lands back on Invitations.
  const stored: PeopleTab = isPeopleTab(storedTab) ? storedTab : "members";
  const tab: PeopleTab = stored === "invitations" && !canManage ? "members" : stored;
  const canCreateTeam = teamCreationFor(workspace) !== "unavailable";
  // While no team exists the Teams tab's empty state has its own Create, as the design draws it.
  // Guests come from note shares, never an invite, so Add there would read as "add a guest" while
  // sending a member invitation; each guest row keeps its own Invite to workspace.
  const showAdd =
    (canManage || canCreateTeam) && tab !== "guests" && !(tab === "teams" && teamsEmpty);
  const visibleTabs = PEOPLE_TABS.filter((id) => id !== "invitations" || canManage);

  // Cmd or Ctrl+F goes to the search field instead of the browser's find, which this window lacks.
  const searchable = tab === "members";
  useEffect(() => {
    if (!searchable) return undefined;
    const focusSearch = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "f") return;
      const field = searchInputRef.current;
      if (!field) return;
      event.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [searchable]);

  const knownEmails = useMemo(
    () => ({
      members: roster.map((member) => member.email.toLowerCase()),
      invited: invitations.invitations
        .filter((invitation) => invitationStatus(invitation, Date.now()) === "pending")
        .map((invitation) => invitation.email.toLowerCase()),
    }),
    [roster, invitations.invitations]
  );

  const openInvite = useCallback((): void => {
    invitedCountRef.current = 0;
    setInviteOpen(true);
    // Only the Members tab loads the roster, so Add opened from Invitations right after launch
    // would flag nobody. A failed read is fine: the server still answers already_member.
    if (!rosterIsOurs) void refreshMembers(workspace.id).catch(() => undefined);
  }, [rosterIsOurs, refreshMembers, workspace.id]);

  const requestCreateTeam = useCallback((): void => {
    onSelectTab("teams");
    setCreateRequested(true);
  }, [onSelectTab]);

  const handleCreateHandled = useCallback((): void => setCreateRequested(false), []);

  const handleInviteOpenChange = useCallback(
    (open: boolean): void => {
      setInviteOpen(open);
      if (!open && invitedCountRef.current > 0) onSelectTab("invitations");
    },
    [onSelectTab]
  );

  const { reload } = invitations;
  const handleInvited = useCallback((emails: string[]): void => {
    invitedCountRef.current += emails.length;
  }, []);

  return (
    <>
      {/* The end padding keeps Add clear of the modal's Close, which sits in this corner. */}
      <div className="flex shrink-0 items-center gap-3 pe-8">
        <div className="min-w-0 flex-1">
          <h2 className={PAGE_TITLE}>{t("settingsPage.workspace.people.title")}</h2>
          <p className={PAGE_DESCRIPTION}>
            {t(
              canManage
                ? "settingsPage.workspace.people.description"
                : "settingsPage.workspace.people.subtitleView"
            )}
          </p>
        </div>
        {showAdd && (
          <div className={cn(SPLIT_PILL, "bg-surface-1 dark:bg-surface-2")}>
            <button
              type="button"
              // A tooltip rather than an aria-label, so the accessible name stays the visible "Add"
              // that voice control users say.
              title={t("settingsPage.workspace.people.addLabel")}
              onClick={canManage ? openInvite : requestCreateTeam}
              className={SPLIT_PILL_LABEL}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("settingsPage.workspace.people.add")}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("settingsPage.workspace.people.addMenu.label")}
                  className={SPLIT_PILL_CHEVRON}
                >
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canManage && (
                  <DropdownMenuItem onSelect={openInvite}>
                    {t("settingsPage.workspace.people.addMenu.invite")}
                  </DropdownMenuItem>
                )}
                {canCreateTeam && (
                  <DropdownMenuItem onSelect={requestCreateTeam}>
                    {t("settingsPage.workspace.people.addMenu.createTeam")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <div className="mt-8 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          className="flex items-center gap-2 rounded-full bg-surface-1 p-1 dark:bg-surface-2"
        >
          {visibleTabs.map((id) => {
            const Icon = TAB_ICONS[id];
            return (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => onSelectTab(id)}
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium leading-[1.5] outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring/40",
                  tab === id
                    ? cn(RAISED_PILL, "text-foreground")
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {t(`settingsPage.workspace.tab.${id}`)}
              </button>
            );
          })}
        </div>
        {tab === "members" && (
          <div className="relative w-full sm:w-[240px]">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
            />
            <Input
              ref={searchInputRef}
              type="search"
              dir="auto"
              autoComplete="off"
              spellCheck={false}
              value={searchQuery}
              placeholder={t("settingsPage.workspace.people.search.placeholder")}
              aria-label={t("settingsPage.workspace.people.search.placeholder")}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              // Lets the Settings dialog hold its own Escape while there is a query to clear.
              {...{ [ESCAPE_CLEARS_ATTRIBUTE]: searchQuery ? "" : undefined }}
              className="h-[34px] rounded-full border-border bg-surface-1 ps-9 pe-8 py-1.5 focus-visible:border-primary dark:border-border-subtle dark:bg-surface-2 dark:focus-visible:border-primary [&::-webkit-search-cancel-button]:appearance-none"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label={t("settingsPage.workspace.people.search.clear")}
                onClick={clearSearch}
                className="absolute end-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-link transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Members scrolls only its table; the other tabs scroll here, under the fixed header. */}
      <div
        className={cn("mt-3 flex min-h-0 flex-1 flex-col", tab !== "members" && "overflow-y-auto")}
      >
        {tab === "members" && (
          <WorkspaceMembersTab
            workspace={workspace}
            searchQuery={searchQuery}
            searchInputRef={searchInputRef}
            onClearSearch={clearSearch}
            onOpenTeamspace={onOpenTeamspace}
          />
        )}
        {tab === "invitations" && (
          <WorkspaceInvitationsTab workspace={workspace} invitations={invitations} />
        )}
        {tab === "guests" && (
          <WorkspaceGuestsTab workspace={workspace} onInvitationsChanged={reload} />
        )}
        {tab === "teams" && (
          <WorkspaceTeamsTab
            workspace={workspace}
            openCreateRequested={createRequested}
            onCreateRequestHandled={handleCreateHandled}
            onTeamsEmptyChange={setTeamsEmpty}
          />
        )}
      </div>

      {canManage && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={handleInviteOpenChange}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          onInvited={handleInvited}
          onInvitationsChanged={reload}
          knownEmails={
            rosterIsOurs && invitations.status === "ready" && !invitations.stale
              ? knownEmails
              : undefined
          }
        />
      )}
    </>
  );
}

export default function WorkspacePeopleSection({
  initialSubTab,
  onOpenTeamspace,
}: Props): React.ReactElement | null {
  const state = useSettingsWorkspace();
  const [storedTab, setStoredTab] = useLocalStorage<string>(
    PEOPLE_TAB_KEY,
    isPeopleTab(initialSubTab) ? initialSubTab : (legacyPeopleTab() ?? "members")
  );

  useEffect(() => {
    if (isPeopleTab(initialSubTab)) setStoredTab(initialSubTab);
  }, [initialSubTab, setStoredTab]);

  const [searchQuery, setSearchQuery] = useState("");
  const workspaceId = state.workspace?.id;

  useEffect(() => {
    setSearchQuery("");
  }, [workspaceId]);

  return (
    <SettingsWorkspaceFrame state={state} fill>
      {(workspace) => (
        <PeopleBody
          key={workspace.id}
          workspace={workspace}
          storedTab={storedTab}
          onSelectTab={setStoredTab}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onOpenTeamspace={onOpenTeamspace}
        />
      )}
    </SettingsWorkspaceFrame>
  );
}
