import { useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Trash2, Users } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { Workspace, WorkspaceMember } from "../../types/electron";
import { AddToTeamList } from "../workspace/AddToTeamList";
import type { PeopleTeamAdd } from "../workspace/PeopleAddMenu";

const ASSIGNABLE_ROLES = ["member", "admin"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

function isAssignableRole(value: string): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

interface MemberRoleMenuProps {
  member: WorkspaceMember;
  isSelf: boolean;
  canManage: boolean;
  canTransfer: boolean;
  /** A role change for this row is in flight. */
  pending: boolean;
  onRoleChange: (role: AssignableRole) => void;
  onTransfer: () => void;
  onRemove: () => void;
  /**
   * Adds this person to a team. Both are given to whoever may manage members; without them the
   * menu has no Add to team.
   */
  workspace?: Workspace;
  teamAdd?: PeopleTeamAdd;
}

export function MemberRoleMenu({
  member,
  isSelf,
  canManage,
  canTransfer,
  pending,
  onRoleChange,
  onTransfer,
  onRemove,
  workspace,
  teamAdd,
}: MemberRoleMenuProps): ReactElement {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const roleLabel = t(`settingsPage.workspace.role.${member.role}`);

  if (member.role === "owner" || isSelf || !canManage) {
    return <span className="text-xs text-muted-foreground">{roleLabel}</span>;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        disabled={pending}
        aria-label={t("settingsPage.workspace.people.roleMenuLabel", {
          name: member.name || member.email,
        })}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 active:bg-foreground/8 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-foreground/5 dark:hover:bg-white/5"
      >
        <span>{roleLabel}</span>
        {pending ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuRadioGroup
          value={member.role}
          onValueChange={(value) => {
            if (value === member.role || !isAssignableRole(value)) return;
            onRoleChange(value);
          }}
        >
          {ASSIGNABLE_ROLES.map((role) => (
            <DropdownMenuRadioItem
              key={role}
              value={role}
              className="items-start rounded-lg py-2 [&>span:first-child]:top-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-foreground">
                  {t(`settingsPage.workspace.role.${role}`)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`settingsPage.workspace.people.roleDescription.${role}`)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {workspace && teamAdd ? (
          <DropdownMenuSub onOpenChange={(open) => open && teamAdd.open()}>
            <DropdownMenuSubTrigger className="gap-2 rounded-lg px-2.5 py-2 text-xs focus:bg-muted data-[state=open]:bg-muted">
              <Users className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {t("settingsPage.workspace.people.selection.addToTeam")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent
                sideOffset={6}
                className="w-64 max-w-[calc(100vw-32px)] rounded-xl p-1.5"
              >
                <AddToTeamList
                  workspace={workspace}
                  teams={teamAdd.teams}
                  people={[member]}
                  onChoose={(team) =>
                    teamAdd.add(team, [member], {
                      returnFocus: () => triggerRef.current?.focus(),
                    })
                  }
                />
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        ) : null}
        {canTransfer && (
          <DropdownMenuItem className="text-xs" onSelect={onTransfer}>
            {t("settingsPage.workspace.members.transferOwnership")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-xs text-destructive focus:text-destructive"
          onSelect={onRemove}
        >
          <Trash2 className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("settingsPage.workspace.members.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
