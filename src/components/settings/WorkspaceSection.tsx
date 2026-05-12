import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users, UserPlus, Trash2 } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import WorkspaceMembersTab from "./WorkspaceMembersTab";
import WorkspaceTeamsTab from "./WorkspaceTeamsTab";
import WorkspaceBillingTab from "./WorkspaceBillingTab";
import WorkspaceDeveloperTab from "./WorkspaceDeveloperTab";
import type { Workspace } from "../../types/electron";

const SUB_TABS = ["general", "members", "teams", "billing", "developer"] as const;
type WorkspaceTab = (typeof SUB_TABS)[number];

interface Props {
  initialSubTab?: string;
}

export default function WorkspaceSection({ initialSubTab }: Props) {
  const { t } = useTranslation();
  const { workspaces, activeWorkspaceId, setActiveWorkspaceId, loaded, refresh } =
    useWorkspaceStore();
  const [tab, setTab] = useLocalStorage<WorkspaceTab>(
    "settings.workspaceTab",
    (SUB_TABS.includes(initialSubTab as WorkspaceTab)
      ? (initialSubTab as WorkspaceTab)
      : "members")
  );
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const workspace = activeWorkspaceId
    ? workspaces.find((w) => w.id === activeWorkspaceId)
    : (workspaces[0] ?? null);

  useEffect(() => {
    if (!activeWorkspaceId && workspaces[0]) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [activeWorkspaceId, workspaces, setActiveWorkspaceId]);

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
        <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    );
  }

  if (!workspace) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          {workspaces.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "group flex items-center gap-1.5 outline-none rounded-md px-2 -mx-2 py-0.5",
                  "hover:bg-foreground/5 dark:hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-primary/30"
                )}
              >
                <h2 className="text-sm font-semibold text-foreground truncate">
                  {workspace.name}
                </h2>
                <span className="text-xs text-muted-foreground">▾</span>
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
          ) : (
            <h2 className="text-sm font-semibold text-foreground truncate">{workspace.name}</h2>
          )}
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(`settingsPage.workspace.role.${workspace.role}`)} · {workspace.slug}
          </p>
        </div>
      </div>

      <div className="border-b border-border/40 dark:border-border-subtle/60 -mx-1">
        <div className="flex gap-0.5 px-1">
          {SUB_TABS.map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "px-3 h-8 text-xs font-medium outline-none transition-colors relative",
                "focus-visible:ring-1 focus-visible:ring-primary/30 rounded-md",
                tab === id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
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
        {tab === "members" && <WorkspaceMembersTab workspace={workspace} />}
        {tab === "teams" && <WorkspaceTeamsTab workspace={workspace} />}
        {tab === "billing" && <WorkspaceBillingTab workspace={workspace} />}
        {tab === "developer" && <WorkspaceDeveloperTab workspace={workspace} />}
      </div>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function GeneralTab({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isOwner = workspace.role === "owner";
  const dirty = name !== workspace.name || slug !== workspace.slug;

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

  async function handleDelete() {
    setSaving(true);
    try {
      await WorkspacesService.remove(workspace.id);
      setActive(null);
      await refresh();
      setConfirmOpen(false);
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
            disabled={!isOwner && workspace.role !== "admin"}
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
            disabled={!isOwner && workspace.role !== "admin"}
            maxLength={48}
            pattern="[a-z0-9-]+"
          />
          <p className="text-[11px] text-muted-foreground">
            {t("settingsPage.workspace.general.slugHint")}
          </p>
        </div>
        <div className="pt-1">
          <Button onClick={handleSave} size="sm" disabled={!dirty || saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>

      {isOwner && (
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
            onClick={() => setConfirmOpen(true)}
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("settingsPage.workspace.general.delete")}
          </Button>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.workspace.general.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settingsPage.workspace.general.confirmDescription", { name: workspace.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={saving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {saving ? t("common.saving") : t("settingsPage.workspace.general.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
