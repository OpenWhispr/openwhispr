import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Copy, Trash2, Check, Key } from "lucide-react";
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
import { WorkspaceApiKeysService } from "../../services/WorkspaceApiKeysService";
import type { Workspace, WorkspaceApiKey, NewWorkspaceApiKey } from "../../types/electron";
import { cn } from "../lib/utils";

interface Props {
  workspace: Workspace;
}

const SCOPE_GROUPS: { title: string; scopes: { id: string; label: string }[] }[] = [
  {
    title: "Notes",
    scopes: [
      { id: "workspace:notes:read", label: "Read notes" },
      { id: "workspace:notes:write", label: "Write notes" },
    ],
  },
  {
    title: "Folders",
    scopes: [
      { id: "workspace:folders:read", label: "Read folders" },
      { id: "workspace:folders:write", label: "Write folders" },
    ],
  },
  {
    title: "Transcriptions",
    scopes: [{ id: "workspace:transcriptions:read", label: "Read transcriptions" }],
  },
  {
    title: "Members",
    scopes: [
      { id: "workspace:members:read", label: "Read members" },
      { id: "workspace:members:write", label: "Manage members" },
    ],
  },
  {
    title: "Billing",
    scopes: [{ id: "workspace:billing:read", label: "Read billing" }],
  },
  {
    title: "Full access",
    scopes: [{ id: "workspace:*", label: "Workspace admin" }],
  },
];

export default function WorkspaceDeveloperTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [keys, setKeys] = useState<WorkspaceApiKey[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<NewWorkspaceApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  async function refresh() {
    try {
      setKeys(await WorkspaceApiKeysService.list(workspace.id));
    } catch {
      setKeys([]);
    }
  }

  useEffect(() => {
    if (canManage) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  function toggleScope(id: string) {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || selectedScopes.size === 0) return;
    setSubmitting(true);
    try {
      const created = await WorkspaceApiKeysService.create(workspace.id, {
        name: name.trim(),
        scopes: Array.from(selectedScopes),
      });
      setNewKey(created);
      setName("");
      setSelectedScopes(new Set());
      setCreateOpen(false);
      await refresh();
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(keyId: string) {
    try {
      await WorkspaceApiKeysService.revoke(workspace.id, keyId);
      await refresh();
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  }

  async function handleCopy() {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.developer.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.developer.description")}
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("settingsPage.workspace.developer.new")}
          </Button>
        )}
      </div>

      <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
        {keys.length === 0 && (
          <div className="py-10 text-center">
            <Key className="w-5 h-5 text-muted-foreground/60 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.workspace.developer.empty")}
            </p>
          </div>
        )}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-4 h-14">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{k.name}</p>
              <p className="text-[11px] font-mono text-muted-foreground truncate">
                {k.key_prefix}…
              </p>
            </div>
            <span className="text-xs text-muted-foreground hidden md:inline">
              {k.last_used_at
                ? t("settingsPage.workspace.developer.lastUsed", {
                    date: new Date(k.last_used_at).toLocaleDateString(),
                  })
                : t("settingsPage.workspace.developer.neverUsed")}
            </span>
            {canManage && (
              <button
                type="button"
                onClick={() => handleRevoke(k.id)}
                aria-label={t("settingsPage.workspace.developer.revoke")}
                className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.workspace.developer.createTitle")}</DialogTitle>
            <DialogDescription>
              {t("settingsPage.workspace.developer.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="key-name" className="text-xs font-medium">
                {t("settingsPage.workspace.developer.nameLabel")}
              </Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder={t("settingsPage.workspace.developer.namePlaceholder")}
                required
              />
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {SCOPE_GROUPS.map((group) => (
                <div key={group.title} className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {group.title}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.scopes.map((s) => {
                      const checked = selectedScopes.has(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => toggleScope(s.id)}
                          className={cn(
                            "h-7 px-2.5 rounded-md border text-xs transition-colors outline-none",
                            "focus-visible:ring-1 focus-visible:ring-primary/30",
                            checked
                              ? "border-primary/40 bg-primary/8 text-foreground"
                              : "border-border/60 text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
                          )}
                        >
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
                disabled={submitting}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || selectedScopes.size === 0 || submitting}
              >
                {submitting ? t("common.saving") : t("settingsPage.workspace.developer.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!newKey} onOpenChange={(open) => !open && setNewKey(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.workspace.developer.keyCreatedTitle")}</DialogTitle>
            <DialogDescription>
              {t("settingsPage.workspace.developer.keyCreatedDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border/60 bg-foreground/4 dark:bg-white/4 p-3 font-mono text-xs break-all">
            {newKey?.key}
          </div>
          <DialogFooter>
            <Button onClick={handleCopy} variant="outline" size="sm">
              {copied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  {t("common.copied")}
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  {t("common.copy")}
                </>
              )}
            </Button>
            <Button onClick={() => setNewKey(null)} size="sm">
              {t("common.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
