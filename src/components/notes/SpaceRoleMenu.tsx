import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Trash2,
  User,
  type IconComponent,
} from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { isolate } from "../../utils/bidiIsolate";
import type { TeamRole } from "../../types/electron";

const ROLES: TeamRole[] = ["member", "admin"];

const ROLE_ICON: Record<TeamRole, IconComponent> = { member: User, admin: ShieldCheck };
const ROLE_LABEL_KEY: Record<TeamRole, string> = {
  member: "settingsPage.workspace.teamspaces.members.roleMember",
  admin: "settingsPage.workspace.teamspaces.members.roleAdmin",
};
const ROLE_BODY_KEY: Record<TeamRole, string> = {
  member: "settingsPage.workspace.teamspaces.members.roleMemberBody",
  admin: "settingsPage.workspace.teamspaces.members.roleAdminBody",
};

// Quiet trigger: reads as the cell's role text with a chevron, not as a button. The negative
// margin keeps the text on the column header's edge.
const TRIGGER_CLASS =
  "-ms-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-foreground outline-none transition-colors " +
  "hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-foreground/5 " +
  "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent dark:hover:bg-white/5";

const ITEM_CLASS =
  "items-start gap-2.5 rounded-lg px-2.5 py-2 ps-2.5 pe-2.5 data-[state=checked]:bg-muted focus:bg-muted " +
  "[&>span:first-child]:hidden";

function isTeamRole(value: string): value is TeamRole {
  return value === "member" || value === "admin";
}

interface SpaceRoleMenuProps {
  role: TeamRole;
  /** The person or team the menu acts on, for its accessible name. */
  subject: string;
  /** A change for this row is in flight. */
  pending: boolean;
  onRoleChange: (role: TeamRole) => void;
  /** Left out for someone with no direct grant here, as there is nothing of theirs to remove. */
  onRemove?: () => void;
  /**
   * The teams (already named for reading aloud) that make this person an admin. While there are
   * some, Member is not on offer: a direct Member role wouldn't lower them, and the row would go
   * on reading Admin.
   */
  adminThrough?: string;
}

// The role cell of a person or team the viewer manages: the two teamspace roles, then removal.
// Roles here only ever affect this teamspace.
export function SpaceRoleMenu({
  role,
  subject,
  pending,
  onRoleChange,
  onRemove,
  adminThrough,
}: SpaceRoleMenuProps): ReactElement {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        aria-label={t("settingsPage.workspace.people.roleMenuLabel", { name: isolate(subject) })}
        className={TRIGGER_CLASS}
      >
        <span>
          {role === "admin"
            ? t("notes.spaces.members.roleAdmin")
            : t("notes.spaces.members.roleMember")}
        </span>
        {pending ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground" aria-hidden="true" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-32px)]">
        <DropdownMenuRadioGroup
          value={role}
          onValueChange={(value) => {
            if (value !== role && isTeamRole(value)) onRoleChange(value);
          }}
        >
          {ROLES.map((option) => {
            const Icon = ROLE_ICON[option];
            const lockedByTeam = option === "member" && Boolean(adminThrough);
            return (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                disabled={lockedByTeam}
                className={ITEM_CLASS}
              >
                <Icon
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {t(ROLE_LABEL_KEY[option])}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {lockedByTeam
                      ? t("notes.spaces.members.roleFromTeam", { team: adminThrough })
                      : t(ROLE_BODY_KEY[option])}
                  </span>
                </span>
                {option === role ? (
                  <Check
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {onRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-2.5 text-sm text-destructive focus:bg-destructive/10 focus:text-destructive"
              onSelect={onRemove}
            >
              <Trash2 className="size-3.5 shrink-0" aria-hidden="true" />
              {t("settingsPage.workspace.teamspaces.members.removeItem")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
