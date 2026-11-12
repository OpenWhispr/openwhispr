import { useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Loader2,
  User,
  UserPlus,
  UserSettings,
  UserXmark,
  type IconComponent,
} from "../icons";
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
import { MENU_ICON, MENU_PANEL, MENU_SUBMENU_TRIGGER } from "../workspace/menuTokens";
import type { PeopleTeamAdd } from "../workspace/PeopleAddMenu";

const ASSIGNABLE_ROLES = ["member", "admin"] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ROLE_ICON: Record<AssignableRole, IconComponent> = { member: User, admin: UserSettings };

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
    return <span className="px-1.5 text-sm text-foreground">{roleLabel}</span>;
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && teamAdd?.menuOpened()}>
      <DropdownMenuTrigger
        ref={triggerRef}
        disabled={pending}
        aria-label={t("settingsPage.workspace.people.roleMenuLabel", {
          name: member.name || member.email,
        })}
        className="inline-flex h-7 items-center gap-1 rounded-lg px-1.5 text-sm text-foreground outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 active:bg-foreground/8 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent data-[state=open]:bg-foreground/5 dark:hover:bg-white/5"
      >
        <span>{roleLabel}</span>
        {pending ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-32px)]">
        <DropdownMenuRadioGroup
          value={member.role}
          onValueChange={(value) => {
            if (value === member.role || !isAssignableRole(value)) return;
            onRoleChange(value);
          }}
        >
          {ASSIGNABLE_ROLES.map((role) => {
            const Icon = ROLE_ICON[role];
            return (
              <DropdownMenuRadioItem
                key={role}
                value={role}
                className="items-start gap-2.5 rounded-lg px-2.5 py-2 ps-2.5 pe-2.5 data-[state=checked]:bg-muted focus:bg-muted [&>span:first-child]:hidden"
              >
                <Icon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-foreground">
                    {t(`settingsPage.workspace.people.roleMenu.${role}`)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(`settingsPage.workspace.people.roleDescription.${role}`)}
                  </span>
                </span>
                {role === member.role ? (
                  <Check
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {workspace && teamAdd ? (
          <DropdownMenuSub onOpenChange={(open) => open && teamAdd.open()}>
            <DropdownMenuSubTrigger className={MENU_SUBMENU_TRIGGER}>
              <UserPlus className={MENU_ICON} aria-hidden="true" />
              {t("settingsPage.workspace.people.selection.addToTeam")}
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent sideOffset={6} className={MENU_PANEL}>
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
          <DropdownMenuItem className="text-sm" onSelect={onTransfer}>
            {t("settingsPage.workspace.members.transferOwnership")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-sm text-destructive focus:text-destructive"
          onSelect={onRemove}
        >
          <UserXmark className="me-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("settingsPage.workspace.members.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
