import React, { Suspense, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Loader2, Plus, UserCircle, UserPlus } from "./icons";
import MemberAvatar from "./MemberAvatar";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "./lib/utils";
import { useAuth } from "../hooks/useAuth";
import { useWorkspace } from "../hooks/useWorkspace";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { WorkspacesService } from "../services/WorkspacesService";
import { resolveWorkspaceSwitcher } from "../lib/workspaceSwitcher";
import type { Workspace } from "../types/electron";

const InviteTeammateDialog = React.lazy(() => import("./InviteTeammateDialog"));

const triggerClass =
  "group flex items-center gap-2.5 w-full h-10 px-2 rounded-md text-start outline-none hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6 data-[state=open]:bg-foreground/5 dark:data-[state=open]:bg-white/6 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const nameClass = "flex-1 min-w-0 truncate text-sm font-medium text-foreground";
const itemClass = "gap-3 px-2 py-2 text-[13px] rounded-lg";
// Counting members fetches the whole roster, so each workspace's count is reused for a while.
const MEMBER_COUNT_TTL_MS = 5 * 60_000;

export default function WorkspaceSwitcher(): React.ReactElement | null {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const { workspaces, setActive, refresh } = useWorkspace();
  const { activeWorkspaceId, loaded, loading, error } = useWorkspaceStore(
    useShallow((s) => ({
      activeWorkspaceId: s.activeWorkspaceId,
      loaded: s.loaded,
      loading: s.loading,
      error: s.error,
    }))
  );
  const [createOpen, setCreateOpen] = useState(false);
  // Right after creating a workspace the invite is optional, so it offers Skip.
  const [invite, setInvite] = useState<{ workspace: Workspace; afterCreate: boolean } | null>(null);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const memberCountRequestedAt = useRef<Record<string, number>>({});

  const state = resolveWorkspaceSwitcher({
    isSignedIn: Boolean(isSignedIn),
    loaded,
    error,
    workspaces,
    activeWorkspaceId,
  });

  if (state.kind === "hidden") return null;

  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2.5 h-10 px-2" aria-hidden="true">
        <span className="w-7 h-7 rounded-full bg-foreground/6 dark:bg-white/8 animate-pulse" />
        <span className="h-2.5 w-20 rounded bg-foreground/6 dark:bg-white/8 animate-pulse" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={loading}
        className={cn(triggerClass, "h-auto min-h-10 py-1.5 disabled:opacity-60")}
      >
        {/* Stacked, so long translations wrap instead of truncating beside Retry. */}
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-xs leading-snug">
          <span className="text-muted-foreground">
            {t("settingsPage.workspace.loadError.title")}
          </span>
          {loading ? (
            <Loader2 size={12} className="animate-spin text-muted-foreground" />
          ) : (
            <span className="font-medium text-primary">
              {t("settingsPage.workspace.loadError.retry")}
            </span>
          )}
        </span>
      </button>
    );
  }

  const current = state.kind === "workspace" ? state.current : null;
  const currentMemberCount = current ? (memberCounts[current.id] ?? null) : null;

  const handleOpenChange = (open: boolean): void => {
    if (!open || !current) return;
    const workspaceId = current.id;
    const now = Date.now();
    if (now - (memberCountRequestedAt.current[workspaceId] ?? 0) < MEMBER_COUNT_TTL_MS) return;
    memberCountRequestedAt.current[workspaceId] = now;
    WorkspacesService.listMembers(workspaceId).then(
      (members) => setMemberCounts((counts) => ({ ...counts, [workspaceId]: members.length })),
      // The count is decoration; the menu works without it. Ask again on the next open.
      () => {
        delete memberCountRequestedAt.current[workspaceId];
      }
    );
  };

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger className={triggerClass}>
          {current ? (
            <MemberAvatar name={current.name} email={null} />
          ) : (
            <UserCircle size={24} className="w-7 shrink-0 text-foreground/50" />
          )}
          <span dir="auto" className={nameClass}>
            {current ? current.name : t("notes.spaces.personal")}
          </span>
          <ChevronsUpDown
            size={14}
            className="shrink-0 text-foreground/45 group-hover:text-foreground/70 transition-colors duration-150"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          // Wider than the sidebar, as in the design, so names and the invite button have room.
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 overflow-y-auto"
        >
          {current && (
            <>
              <div className="flex items-center gap-3 px-2 pt-1.5 pb-2.5">
                <MemberAvatar name={current.name} email={null} />
                <div className="min-w-0">
                  <p dir="auto" className="truncate text-sm font-medium text-foreground">
                    {current.name}
                  </p>
                  {currentMemberCount !== null && (
                    <p className="text-xs text-muted-foreground">
                      {t("workspaces.join.memberCount", { count: currentMemberCount })}
                    </p>
                  )}
                </div>
              </div>
              {state.kind === "workspace" && state.canInvite && (
                <DropdownMenuItem
                  onSelect={() => setInvite({ workspace: current, afterCreate: false })}
                  className="mx-1 mb-1.5 justify-center gap-1.5 rounded-lg py-2 text-[13px] text-foreground/80 bg-foreground/5 dark:bg-white/6 focus:bg-foreground/8 dark:focus:bg-white/10"
                >
                  <UserPlus size={14} />
                  {t("workspaces.switcher.invitePeople")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="-mx-1.5 my-1.5" />
            </>
          )}
          {current ? (
            workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                onSelect={() => setActive(workspace.id)}
                className={itemClass}
              >
                <MemberAvatar name={workspace.name} email={null} />
                <span dir="auto" className="flex-1 min-w-0 truncate">
                  {workspace.name}
                </span>
                {workspace.id === current.id && (
                  <Check size={16} className="shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem className={itemClass} disabled>
              <UserCircle size={24} className="w-7 shrink-0 text-foreground/50" />
              <span className="flex-1">{t("notes.spaces.personal")}</span>
              <Check size={16} className="shrink-0 text-primary" />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setCreateOpen(true)}
            className={cn(itemClass, "text-muted-foreground focus:text-foreground")}
          >
            <span className="flex w-7 shrink-0 justify-center">
              <Plus size={16} />
            </span>
            {t("workspaces.switcher.add")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(workspaceId) => {
          const created = useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId);
          if (created) setInvite({ workspace: created, afterCreate: true });
        }}
      />
      {invite && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open
            onOpenChange={(open) => {
              if (!open) setInvite(null);
            }}
            workspaceId={invite.workspace.id}
            workspaceName={invite.workspace.name}
            cancelLabel={invite.afterCreate ? t("common.skip") : undefined}
          />
        </Suspense>
      )}
    </>
  );
}
