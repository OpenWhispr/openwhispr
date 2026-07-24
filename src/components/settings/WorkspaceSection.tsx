import React, { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Users, UserPlus, Trash2, LogOut, ChevronDown, Loader2 } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useAuth } from "../../hooks/useAuth";
import { useDialogs } from "../../hooks/useDialogs";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import { ConfirmDialog } from "../ui/dialog";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import InviteTeammateDialog from "../InviteTeammateDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { storeSeatIntent } from "../../utils/billingSeatIntent";
import WorkspaceMembersTab from "./WorkspaceMembersTab";
import WorkspaceTeamsTab from "./WorkspaceTeamsTab";
import WorkspaceDeveloperTab from "./WorkspaceDeveloperTab";
import type { Workspace } from "../../types/electron";

const SUB_TABS = ["general", "members", "teams", "developer"] as const;
type WorkspaceTab = (typeof SUB_TABS)[number];

interface Props {
  initialSubTab?: string;
  onNavigateToBilling?: () => void;
}

export default function WorkspaceSection({ initialSubTab, onNavigateToBilling }: Props) {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const { workspaces, activeWorkspaceId, setActiveWorkspaceId, loaded, loading, error, refresh } =
    useWorkspaceStore(
      useShallow((s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        setActiveWorkspaceId: s.setActiveWorkspaceId,
        loaded: s.loaded,
        loading: s.loading,
        error: s.error,
        refresh: s.refresh,
      }))
    );
  const [storedTab, setStoredTab] = useLocalStorage<string>(
    "settings.workspaceTab",
    SUB_TABS.includes(initialSubTab as WorkspaceTab) ? (initialSubTab as WorkspaceTab) : "members"
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);

  function navigateToBilling(workspaceId: string) {
    setActiveWorkspaceId(workspaceId);
    storeSeatIntent(workspaceId, 1);
    onNavigateToBilling?.();
  }

  useEffect(() => {
    if (isSignedIn && !loaded) void refresh();
  }, [isSignedIn, loaded, refresh]);

  useEffect(() => {
    if (initialSubTab && SUB_TABS.includes(initialSubTab as WorkspaceTab)) {
      setStoredTab(initialSubTab);
    }
  }, [initialSubTab, setStoredTab]);

  if (!isSignedIn) return null;

  // Shared by the empty and populated branches so the create→invite chain
  // survives the branch switch when the first workspace lands in the store.
  const inviteWorkspace = inviteWorkspaceId
    ? (workspaces.find((w) => w.id === inviteWorkspaceId) ?? null)
    : null;
  const createDialog = (
    <>
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setInviteWorkspaceId}
      />
      {inviteWorkspace && (
        <InviteTeammateDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setInviteWorkspaceId(null);
          }}
          workspaceId={inviteWorkspace.id}
          workspaceName={inviteWorkspace.name}
          cancelLabel={t("common.skip")}
          onNavigateToBilling={() => navigateToBilling(inviteWorkspace.id)}
        />
      )}
    </>
  );

  if (!loaded) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-32 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.description")}
          </p>
        </div>
        {error ? (
          <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-6 text-center">
            <p className="text-xs font-medium text-foreground mb-1">
              {t("settingsPage.workspace.loadError.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {t("settingsPage.workspace.loadError.description")}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
              {loading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("settingsPage.workspace.loadError.retry")}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-6 text-center">
            <Users className="w-5 h-5 text-muted-foreground/60 mx-auto mb-2" />
            <p className="text-xs font-medium text-foreground mb-1">
              {t("settingsPage.workspace.empty.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {t("settingsPage.workspace.empty.description")}
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {t("settingsPage.workspace.empty.create")}
            </Button>
          </div>
        )}
        {createDialog}
      </div>
    );
  }

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  const canManage = workspace.role === "owner" || workspace.role === "admin";
  const visibleTabs = SUB_TABS.filter((id) => id !== "developer" || canManage);
  const tab: WorkspaceTab = visibleTabs.includes(storedTab as WorkspaceTab)
    ? (storedTab as WorkspaceTab)
    : "members";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              className={cn(
                "group flex items-center gap-1.5 outline-none rounded-md px-2 -mx-2 py-0.5",
                "hover:bg-foreground/5 dark:hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-primary/30"
              )}
            >
              <h2 className="text-sm font-semibold text-foreground truncate">{workspace.name}</h2>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-medium">
                {t("workspaces.switcher.workspaces")}
              </DropdownMenuLabel>
              {workspaces.map((w) => (
                <DropdownMenuItem
                  key={w.id}
                  onSelect={() => setActiveWorkspaceId(w.id)}
                  className="text-xs"
                >
                  {w.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="text-xs">
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                {t("workspaces.switcher.create")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(`settingsPage.workspace.role.${workspace.role}`)} · {workspace.slug}
          </p>
        </div>
      </div>

      <div className="border-b border-border/40 dark:border-border-subtle/60 -mx-1">
        <div role="tablist" className="flex gap-0.5 px-1">
          {visibleTabs.map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setStoredTab(id)}
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
      </div>

      <div className="pt-1">
        {tab === "general" && <GeneralTab workspace={workspace} />}
        {tab === "members" && (
          <WorkspaceMembersTab
            workspace={workspace}
            onNavigateToBilling={() => navigateToBilling(workspace.id)}
          />
        )}
        {tab === "teams" && <WorkspaceTeamsTab workspace={workspace} />}
        {tab === "developer" && canManage && <WorkspaceDeveloperTab workspace={workspace} />}
      </div>

      {createDialog}
    </div>
  );
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

function GeneralTab({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const isOwner = workspace.role === "owner";
  const canEdit = isOwner || workspace.role === "admin";
  const dirty = name !== workspace.name || slug !== workspace.slug;
  const slugInvalid = slug.length > 0 && !SLUG_PATTERN.test(slug);

  useEffect(() => {
    setName(workspace.name);
    setSlug(workspace.slug);
  }, [workspace.id, workspace.name, workspace.slug]);

  async function handleSave() {
    setSaving(true);
    try {
      await WorkspacesService.update(workspace.id, { name, slug });
      await refresh();
      toast({ title: t("settingsPage.workspace.general.saved") });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    showConfirmDialog({
      title: t("settingsPage.workspace.general.confirmTitle", { name: workspace.name }),
      description: t("settingsPage.workspace.general.confirmDescription"),
      confirmText: t("settingsPage.workspace.general.delete"),
      variant: "destructive",
      onConfirm: async () => {
        setDeleting(true);
        try {
          await WorkspacesService.remove(workspace.id);
          setActive(null);
          await refresh();
          toast({ title: t("settingsPage.workspace.general.deleted") });
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setDeleting(false);
        }
      },
    });
  }

  function confirmLeave() {
    showConfirmDialog({
      title: t("settingsPage.workspace.general.leaveConfirm.title", { name: workspace.name }),
      description: t("settingsPage.workspace.general.leaveConfirm.description"),
      confirmText: t("settingsPage.workspace.general.leave"),
      variant: "destructive",
      onConfirm: async () => {
        if (!user?.id) return;
        setLeaving(true);
        try {
          await WorkspacesService.removeMember(workspace.id, user.id);
          setActive(null);
          await refresh();
          toast({ title: t("settingsPage.workspace.general.left", { name: workspace.name }) });
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setLeaving(false);
        }
      },
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="ws-name" className="text-xs font-medium">
            {t("settingsPage.workspace.general.nameLabel")}
          </Label>
          <Input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            maxLength={80}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ws-slug" className="text-xs font-medium">
            {t("settingsPage.workspace.general.slugLabel")}
          </Label>
          <Input
            id="ws-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!canEdit}
            maxLength={48}
            aria-invalid={slugInvalid}
          />
          {slugInvalid ? (
            <p className="text-[11px] text-destructive">
              {t("settingsPage.workspace.general.slugInvalid")}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t("settingsPage.workspace.general.slugHint")}
            </p>
          )}
        </div>
        {canEdit && (
          <div className="pt-1">
            <Button
              onClick={handleSave}
              size="sm"
              disabled={!dirty || !name.trim() || !slug || slugInvalid || saving}
            >
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        )}
      </div>

      {isOwner ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/3 dark:bg-destructive/6 p-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-foreground">
              {t("settingsPage.workspace.general.dangerTitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("settingsPage.workspace.general.dangerDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={confirmDelete}
            disabled={deleting}
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
          >
            {deleting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {deleting
              ? t("settingsPage.workspace.general.deleting")
              : t("settingsPage.workspace.general.delete")}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-destructive/30 bg-destructive/3 dark:bg-destructive/6 p-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-foreground">
              {t("settingsPage.workspace.general.leaveTitle")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("settingsPage.workspace.general.leaveDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={confirmLeave}
            disabled={leaving}
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
          >
            {leaving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
            )}
            {leaving
              ? t("settingsPage.workspace.general.leaving")
              : t("settingsPage.workspace.general.leave")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
