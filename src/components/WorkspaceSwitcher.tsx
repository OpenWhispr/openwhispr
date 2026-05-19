import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { useWorkspace } from "../hooks/useWorkspace";
import { cn } from "./lib/utils";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";

function workspaceInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function WorkspaceSwitcher({ userName }: { userName?: string | null }) {
  const { t } = useTranslation();
  const { workspaces, active, setActive } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);

  const label = active ? active.name : t("workspaces.switcher.personal");
  const initials = active
    ? workspaceInitials(active.name)
    : (userName?.[0]?.toUpperCase() ?? "P");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "group flex items-center w-full h-8 px-2 rounded-md outline-none gap-2",
            "hover:bg-foreground/5 dark:hover:bg-white/5 transition-colors",
            "focus-visible:ring-1 focus-visible:ring-primary/30"
          )}
        >
          <span
            className={cn(
              "shrink-0 w-5 h-5 rounded-md text-[10px] font-semibold flex items-center justify-center",
              active
                ? "bg-primary/12 text-primary"
                : "bg-foreground/8 text-foreground/70 dark:bg-white/8 dark:text-foreground/65"
            )}
          >
            {initials}
          </span>
          <span className="flex-1 text-xs text-left text-foreground/85 truncate">{label}</span>
          <ChevronsUpDown size={12} className="text-foreground/40 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-[12rem]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-medium">
            {t("workspaces.switcher.workspaces")}
          </DropdownMenuLabel>
          {workspaces.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("workspaces.switcher.empty")}
            </div>
          )}
          {workspaces.map((ws) => {
            const isActive = active?.id === ws.id;
            return (
              <DropdownMenuItem
                key={ws.id}
                onSelect={() => setActive(ws.id)}
                className="gap-2 text-xs"
              >
                <span
                  className={cn(
                    "shrink-0 w-5 h-5 rounded-md text-[10px] font-semibold flex items-center justify-center",
                    "bg-primary/12 text-primary"
                  )}
                >
                  {workspaceInitials(ws.name)}
                </span>
                <span className="flex-1 truncate">{ws.name}</span>
                {isActive && <Check size={12} className="text-foreground/60" />}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setActive(null)} className="gap-2 text-xs">
            <span className="shrink-0 w-5 h-5 rounded-md text-[10px] font-semibold flex items-center justify-center bg-foreground/8 text-foreground/70 dark:bg-white/8 dark:text-foreground/65">
              {userName?.[0]?.toUpperCase() ?? "P"}
            </span>
            <span className="flex-1 truncate">{t("workspaces.switcher.personal")}</span>
            {!active && <Check size={12} className="text-foreground/60" />}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="gap-2 text-xs">
            <Plus size={12} className="text-foreground/55" />
            <span>{t("workspaces.switcher.create")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
