import { useTranslation } from "react-i18next";
import { Check, Loader2, Search } from "lucide-react";
import MemberAvatar from "./MemberAvatar";
import { cn } from "./lib/utils";
import type { WorkspaceMember } from "../types/electron";

interface MemberPickListProps {
  members: WorkspaceMember[];
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (member: WorkspaceMember) => void;
  /** Toggle mode: selected rows show a check and expose aria-pressed. */
  selectedIds?: Set<string>;
  /** Marks this member's row with a "You" hint. */
  currentUserId?: string;
  /** Rows awaiting a server round-trip: disabled with a spinner. */
  busyIds?: Set<string>;
  /** Extra classes for the scroll list (defaults the max height). */
  listClassName?: string;
  /** Rendered at the end of the list (e.g. an invite affordance). */
  footer?: React.ReactNode;
}

export default function MemberPickList({
  members,
  search,
  onSearchChange,
  onSelect,
  selectedIds,
  currentUserId,
  busyIds,
  listClassName,
  footer,
}: MemberPickListProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded border border-border/70 dark:border-border-subtle/50 overflow-hidden">
      <div className="relative border-b border-border/40 dark:border-border-subtle/40">
        <Search
          size={11}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/25 pointer-events-none"
        />
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("notes.spaces.members.searchPlaceholder")}
          className="w-full h-8 pl-7 pr-2 bg-transparent text-xs text-foreground placeholder:text-foreground/25 outline-none"
        />
      </div>
      <div className={cn("overflow-y-auto p-1", listClassName ?? "max-h-36")}>
        {members.map((member) => {
          const isSelected = selectedIds?.has(member.user_id) ?? false;
          const isBusy = busyIds?.has(member.user_id) ?? false;
          return (
            <button
              key={member.user_id}
              type="button"
              disabled={isBusy}
              aria-pressed={selectedIds ? isSelected : undefined}
              onClick={() => onSelect(member)}
              className={cn(
                "flex items-center gap-2 w-full px-2 h-8 rounded-md text-left",
                "transition-colors duration-150 outline-none",
                "hover:bg-foreground/4 dark:hover:bg-white/4",
                "focus-visible:ring-1 focus-visible:ring-ring/30",
                "disabled:opacity-60"
              )}
            >
              <MemberAvatar name={member.name} email={member.email} size="sm" />
              <span className="text-xs text-foreground truncate flex-1">
                {member.name || member.email}
              </span>
              {member.user_id === currentUserId && (
                <span className="text-[10px] text-foreground/40 shrink-0">
                  {t("notes.spaces.members.you")}
                </span>
              )}
              {isSelected && <Check size={11} className="text-primary shrink-0" />}
              {isBusy && (
                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
              )}
            </button>
          );
        })}
        {members.length === 0 && !footer && (
          <p className="text-xs text-foreground/25 text-center py-2">
            {t("notes.context.noResults")}
          </p>
        )}
        {footer}
      </div>
    </div>
  );
}
