import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import { UserPlus } from "../icons";
import { workspaceCan } from "../../lib/capabilities";
import { invitationStatus, rosterFor } from "../../lib/peopleRoster";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace } from "../../types/electron";
import InviteTeammateDialog from "../InviteTeammateDialog";
import WorkspaceInvitationsTab from "./WorkspaceInvitationsTab";
import WorkspaceMembersTab from "./WorkspaceMembersTab";
import WorkspaceTeamsTab from "./WorkspaceTeamsTab";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { useSettingsWorkspace } from "./useSettingsWorkspace";
import { useWorkspaceInvitations } from "./useWorkspaceInvitations";

const PEOPLE_TABS = ["members", "invitations", "teams"] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number];

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
}

interface BodyProps {
  workspace: Workspace;
  storedTab: string;
  onSelectTab: (tab: PeopleTab) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

function PeopleBody({
  workspace,
  storedTab,
  onSelectTab,
  searchQuery,
  onSearchQueryChange,
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
  const invitedCountRef = useRef(0);

  // Without the capability the stored choice only reads as Members; it isn't overwritten, so a
  // member who later becomes an admin lands back on Invitations.
  const stored: PeopleTab = isPeopleTab(storedTab) ? storedTab : "members";
  const tab: PeopleTab = stored === "invitations" && !canManage ? "members" : stored;
  const visibleTabs = PEOPLE_TABS.filter((id) => id !== "invitations" || canManage);

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

  const handleInviteOpenChange = useCallback(
    (open: boolean): void => {
      setInviteOpen(open);
      if (!open && invitedCountRef.current > 0) onSelectTab("invitations");
    },
    [onSelectTab]
  );

  const { reload } = invitations;
  const handleInvited = useCallback(
    (emails: string[]): void => {
      invitedCountRef.current += emails.length;
      void reload();
    },
    [reload]
  );

  return (
    <>
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t("settingsPage.workspace.people.title")}
        </h2>
        <p className="text-xs text-muted-foreground/80 mt-0.5">
          {t(
            canManage
              ? "settingsPage.workspace.people.description"
              : "settingsPage.workspace.people.subtitleView"
          )}
        </p>
      </div>

      <div className="border-b border-border/70 dark:border-border-subtle/60 -mx-1 flex items-center gap-0.5 px-1">
        <div role="tablist" className="flex items-center gap-0.5">
          {visibleTabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => onSelectTab(id)}
              className={cn(
                "px-3 h-8 text-xs font-medium outline-none transition-colors relative",
                "focus-visible:ring-1 focus-visible:ring-primary/30 rounded-md",
                tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`settingsPage.workspace.tab.${id}`)}
              {tab === id && (
                <span className="absolute -bottom-px left-2 right-2 h-px bg-primary" />
              )}
            </button>
          ))}
        </div>
        {canManage && (
          <button
            type="button"
            // A tooltip rather than an aria-label, so the accessible name stays the visible "Add"
            // that voice control users say.
            title={t("settingsPage.workspace.people.addLabel")}
            onClick={openInvite}
            className="ms-auto mb-1 inline-flex h-7 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <UserPlus className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.people.add")}
          </button>
        )}
      </div>

      <div className="pt-1">
        {tab === "members" && (
          <WorkspaceMembersTab
            workspace={workspace}
            searchQuery={searchQuery}
            onSearchQueryChange={onSearchQueryChange}
          />
        )}
        {tab === "invitations" && (
          <WorkspaceInvitationsTab workspace={workspace} invitations={invitations} />
        )}
        {tab === "teams" && <WorkspaceTeamsTab workspace={workspace} />}
      </div>

      {canManage && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={handleInviteOpenChange}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          onInvited={handleInvited}
          knownEmails={knownEmails}
        />
      )}
    </>
  );
}

export default function WorkspacePeopleSection({
  initialSubTab,
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
    <SettingsWorkspaceFrame state={state}>
      {(workspace) => (
        <PeopleBody
          key={workspace.id}
          workspace={workspace}
          storedTab={storedTab}
          onSelectTab={setStoredTab}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
        />
      )}
    </SettingsWorkspaceFrame>
  );
}
