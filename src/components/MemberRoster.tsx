import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Mail } from "./icons";
import { Button } from "./ui/button";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "./lib/utils";
import MemberAvatar from "./MemberAvatar";
import MemberPickList from "./MemberPickList";
import RoleBadge from "./RoleBadge";
import { formatList } from "../lib/formatList";
import type { TeamRole, WorkspaceMember } from "../types/electron";

const ROLES: TeamRole[] = ["admin", "member"];
const ROLE_LABEL_KEY: Record<TeamRole, string> = {
  admin: "notes.spaces.members.roleAdmin",
  member: "notes.spaces.members.roleMember",
};
const ROLE_DESCRIPTION_KEY: Record<TeamRole, string> = {
  admin: "notes.spaces.members.roleAdminDescription",
  member: "notes.spaces.members.roleMemberDescription",
};
// Quiet trigger: reads as the row's role text with a chevron, not a button.
const ROLE_TRIGGER_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-foreground/80 outline-none transition-colors " +
  "hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/30 data-[state=open]:bg-foreground/5 " +
  "disabled:opacity-60 dark:hover:bg-white/5 dark:data-[state=open]:bg-white/5";

export interface RosterMember {
  user_id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: TeamRole;
  /** Direct grant on the container; null when the row exists only through groups. */
  direct_role?: TeamRole | null;
  /** Names of the groups that grant this row access. */
  via?: string[];
  /** Groups whose grant alone makes this row an admin; a demotion here can't lower that. */
  adminVia?: string[];
}

interface MemberRosterProps<M extends RosterMember> {
  members: M[];
  loading: boolean;
  loadFailed: boolean;
  onRetry: () => void;
  currentUserId?: string;
  canManage: boolean;
  /** Rows with a server round-trip in flight. */
  busyIds: Set<string>;
  onRoleChange: (member: M, role: TeamRole) => void;
  /** The wrapper owns confirmation and the actual removal. */
  onRemove: (member: M) => void;
  /** Workspace members not yet on the roster. */
  addCandidates: WorkspaceMember[];
  onAdd: (member: WorkspaceMember) => void;
  /** Shown when typing an unknown email in the add search (invite affordance). */
  onInvite?: (email: string) => void;
}

// Presentational roster shared by team and space membership: rows with a
// quiet role menu, plus the add-people block. Data loading and mutations
// live in the wrappers (TeamRosterSection, SpaceMembersPanel).
export default function MemberRoster<M extends RosterMember>({
  members,
  loading,
  loadFailed,
  onRetry,
  currentUserId,
  canManage,
  busyIds,
  onRoleChange,
  onRemove,
  addCandidates,
  onAdd,
  onInvite,
}: MemberRosterProps<M>) {
  const { t, i18n } = useTranslation();
  const [addSearch, setAddSearch] = useState("");
  const formatGroups = (names: string[]) => formatList(i18n.language, names);

  const searchEmail = addSearch.trim().toLowerCase();
  // addCandidates is the workspace roster minus current members, so together
  // they cover everyone already in the workspace.
  const showInviteFooter =
    !!onInvite &&
    searchEmail.includes("@") &&
    !members.some((m) => m.email.toLowerCase() === searchEmail) &&
    !addCandidates.some((m) => m.email.toLowerCase() === searchEmail);

  return (
    <div className="space-y-2">
      {loading && members.length === 0 ? (
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      ) : loadFailed && members.length === 0 ? (
        <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.workspace.members.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("settingsPage.workspace.loadError.retry")}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 divide-y divide-border/60 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50 max-h-64 overflow-y-auto">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId;
            const isBusy = busyIds.has(member.user_id);
            const groups = member.via ?? [];
            // Only a group grants this row: removal happens in that group.
            const viaGroupOnly = !member.direct_role && groups.length > 0;
            const adminVia = member.adminVia ?? [];
            return (
              <div key={member.user_id} className="flex items-center gap-3 px-4 h-14">
                <MemberAvatar name={member.name} email={member.email} image={member.image} />
                <div className="flex-1 min-w-0">
                  <p dir="auto" className="text-xs font-medium text-foreground truncate">
                    {member.name || member.email}
                  </p>
                  {member.name && (
                    <p dir="ltr" className="text-xs text-muted-foreground truncate">
                      {member.email}
                    </p>
                  )}
                </div>
                {groups.length > 0 && (
                  <span className="text-[10px] text-foreground/45 truncate max-w-32">
                    {t("notes.spaces.members.viaGroup", { group: formatGroups(groups) })}
                  </span>
                )}
                {canManage && !isSelf ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" disabled={isBusy} className={ROLE_TRIGGER_CLASS}>
                        {t(ROLE_LABEL_KEY[member.role])}
                        {isBusy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <ChevronDown size={12} className="text-foreground/45" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      {ROLES.map((role) => {
                        const lockedByGroup = role === "member" && adminVia.length > 0;
                        return (
                          <DropdownMenuItem
                            key={role}
                            disabled={lockedByGroup}
                            onClick={() => {
                              if (role !== member.role) onRoleChange(member, role);
                            }}
                            className="flex-col items-start gap-0.5 rounded-md px-2 py-1.5"
                          >
                            <span className="flex w-full items-center text-xs font-medium">
                              {t(ROLE_LABEL_KEY[role])}
                              {member.role === role && (
                                <Check size={12} className="ms-auto text-primary" />
                              )}
                            </span>
                            <span className="text-[11px] text-muted-foreground whitespace-normal">
                              {lockedByGroup
                                ? t("notes.spaces.members.roleFromGroup", {
                                    group: formatGroups(adminVia),
                                  })
                                : t(ROLE_DESCRIPTION_KEY[role])}
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                      <DropdownMenuSeparator />
                      {viaGroupOnly ? (
                        <DropdownMenuItem
                          disabled
                          className="rounded-md px-2 py-1.5 text-[11px] text-muted-foreground whitespace-normal"
                        >
                          {t("notes.spaces.members.managedByGroup", {
                            group: formatGroups(groups),
                          })}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => onRemove(member)}
                          className="rounded-md px-2 py-1.5 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          {t("notes.spaces.members.remove")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <RoleBadge label={t(ROLE_LABEL_KEY[member.role])} />
                )}
              </div>
            );
          })}
          {members.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t("notes.spaces.members.empty")}
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground/50">
            {t("notes.spaces.members.addPeople")}
          </label>
          <MemberPickList
            revealOnFocus
            members={addCandidates}
            search={addSearch}
            onSearchChange={setAddSearch}
            onSelect={onAdd}
            currentUserId={currentUserId}
            busyIds={busyIds}
            listClassName="max-h-32"
            footer={
              showInviteFooter ? (
                <button
                  type="button"
                  onClick={() => {
                    onInvite?.(addSearch.trim());
                    setAddSearch("");
                  }}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 h-8 rounded-md text-start",
                    "transition-colors duration-150 outline-none",
                    "text-primary/80 hover:text-primary hover:bg-primary/8",
                    "focus-visible:ring-1 focus-visible:ring-ring/30"
                  )}
                >
                  <Mail size={12} className="shrink-0" />
                  <span className="text-xs truncate">
                    <BidiInterpolatedText
                      text={t("notes.spaces.members.inviteFooter", {
                        email: BIDI_VALUE_TOKEN,
                      })}
                      value={addSearch.trim()}
                    />
                  </span>
                </button>
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
