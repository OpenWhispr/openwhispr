import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Copy, Trash2, Check, Key, Loader2 } from "../icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { WorkspaceApiKeysService } from "../../services/WorkspaceApiKeysService";
import type { Workspace, WorkspaceApiKey, NewWorkspaceApiKey } from "../../types/electron";
import { cn } from "../lib/utils";
import { useDialogSession } from "../../hooks/useDialogSession";

interface Props {
  workspace: Workspace;
}

const SCOPE_GROUPS_DEF: { groupKey: string; scopes: { id: string; labelKey: string }[] }[] = [
  {
    groupKey: "notes",
    scopes: [
      { id: "workspace:notes:read", labelKey: "read" },
      { id: "workspace:notes:write", labelKey: "write" },
    ],
  },
  {
    groupKey: "folders",
    scopes: [
      { id: "workspace:folders:read", labelKey: "read" },
      { id: "workspace:folders:write", labelKey: "write" },
    ],
  },
  {
    groupKey: "transcriptions",
    scopes: [{ id: "workspace:transcriptions:read", labelKey: "read" }],
  },
  {
    groupKey: "members",
    scopes: [
      { id: "workspace:members:read", labelKey: "read" },
      { id: "workspace:members:write", labelKey: "write" },
    ],
  },
  {
    groupKey: "billing",
    scopes: [{ id: "workspace:billing:read", labelKey: "read" }],
  },
  {
    groupKey: "full",
    scopes: [{ id: "workspace:*", labelKey: "admin" }],
  },
];

export default function WorkspaceDeveloperTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const [keys, setKeys] = useState<WorkspaceApiKey[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<NewWorkspaceApiKey | null>(null);
  const [copiedKey, setCopiedKey] = useState<NewWorkspaceApiKey | null>(null);
  const copied = newKey !== null && copiedKey === newKey;
  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyRequest = useRef(0);
  const secretLease = useRef<NewWorkspaceApiKey | null>(null);
  const { sessionKey, capture, bindSession } = useDialogSession(
    true,
    JSON.stringify([workspace.id, workspace.role])
  );
  const { capture: captureCreateForm, bindSession: bindCreateForm } = useDialogSession(
    createOpen,
    sessionKey
  );
  const [previousOwner, setPreviousOwner] = useState(sessionKey);
  if (previousOwner !== sessionKey) {
    setPreviousOwner(sessionKey);
    setNewKey(null);
    setCopiedKey(null);
    setKeys([]);
    setName("");
    setSelectedScopes(new Set());
    setSubmitting(false);
    setCreateOpen(false);
    setLoadError(false);
  }

  const invalidateCopy = useCallback(() => {
    ++copyRequest.current;
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
  }, []);
  const keysRequest = useRef(0);
  const bindOwner = useCallback(
    (node: HTMLDivElement | null) => {
      const cleanup = bindSession(node);
      if (!cleanup) return;
      return () => {
        cleanup();
        ++keysRequest.current;
        invalidateCopy();
      };
    },
    [bindSession, invalidateCopy]
  );
  const bindSecret = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !newKey) return;
      secretLease.current = newKey;
      return () => {
        secretLease.current = null;
        invalidateCopy();
      };
    },
    [newKey, invalidateCopy]
  );

  function replaceKey(key: NewWorkspaceApiKey | null) {
    invalidateCopy();
    setCopiedKey(null);
    setNewKey(key);
  }

  const refresh = useCallback(async () => {
    const completion = capture();
    if (!completion.isCurrent()) return;
    const request = ++keysRequest.current;
    setLoadError(false);
    try {
      const list = await WorkspaceApiKeysService.list(workspace.id);
      if (completion.isCurrent() && request === keysRequest.current) setKeys(list);
    } catch {
      if (completion.isCurrent() && request === keysRequest.current) setLoadError(true);
    }
  }, [capture, workspace.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionKey]);

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
    if (!name.trim() || selectedScopes.size === 0 || submitting) return;
    const completion = capture();
    const formCompletion = captureCreateForm();
    setSubmitting(true);
    try {
      const created = await WorkspaceApiKeysService.create(workspace.id, {
        name: name.trim(),
        scopes: Array.from(selectedScopes),
      });
      if (!completion.isCurrent()) return;
      // Keep the one-time secret available while this tab owns it, but don't
      // erase a newer form reopened while creation was pending.
      replaceKey(created);
      if (formCompletion.isCurrent()) {
        setName("");
        setSelectedScopes(new Set());
        setCreateOpen(false);
      }
      await refresh();
    } catch (error) {
      if (!completion.isCurrent()) return;
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      if (completion.isCurrent()) setSubmitting(false);
    }
  }

  function confirmRevoke(key: WorkspaceApiKey) {
    const completion = capture();
    showConfirmDialog({
      title: t("settingsPage.workspace.developer.revokeConfirm.title"),
      description: t("settingsPage.workspace.developer.revokeConfirm.description", {
        name: key.name,
      }),
      confirmText: t("settingsPage.workspace.developer.revoke"),
      variant: "destructive",
      onConfirm: async () => {
        if (!completion.isCurrent()) return;
        try {
          await WorkspaceApiKeysService.revoke(workspace.id, key.id);
          if (!completion.isCurrent()) return;
          await refresh();
          if (!completion.isCurrent()) return;
          toast({ title: t("settingsPage.workspace.developer.revoked", { name: key.name }) });
        } catch (error) {
          if (!completion.isCurrent()) return;
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      },
    });
  }

  async function handleCopy() {
    if (!newKey || secretLease.current !== newKey) return;
    const completion = capture();
    invalidateCopy();
    setCopiedKey(null);
    const request = copyRequest.current;
    const isCurrent = () =>
      completion.isCurrent() && secretLease.current === newKey && request === copyRequest.current;
    try {
      await navigator.clipboard.writeText(newKey.key);
      if (!isCurrent()) return;
      setCopiedKey(newKey);
      copyTimerRef.current = setTimeout(() => {
        if (!isCurrent()) return;
        copyTimerRef.current = null;
        setCopiedKey(null);
      }, 2000);
    } catch {
      // Clipboard write failed — user can still manually select+copy.
    }
  }

  return (
    <div ref={bindOwner} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.developer.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.developer.description")}
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="me-1.5 h-3.5 w-3.5" />
          {t("settingsPage.workspace.developer.new")}
        </Button>
      </div>

      <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 divide-y divide-border/60 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
        {loadError && (
          <div className="px-4 py-6 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.workspace.developer.loadError")}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("settingsPage.workspace.loadError.retry")}
            </Button>
          </div>
        )}
        {!loadError && keys.length === 0 && (
          <div className="py-10 text-center">
            <Key className="w-5 h-5 text-muted-foreground/70 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.workspace.developer.empty")}
            </p>
          </div>
        )}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-3 px-4 h-14">
            <div className="flex-1 min-w-0">
              <p dir="auto" className="text-xs font-medium text-foreground truncate">
                {k.name}
              </p>
              <p dir="ltr" className="text-[11px] font-mono text-muted-foreground truncate">
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
            <button
              type="button"
              onClick={() => confirmRevoke(k)}
              aria-label={t("settingsPage.workspace.developer.revoke")}
              className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
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
          <form ref={bindCreateForm} onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="key-name" className="text-xs font-medium">
                {t("settingsPage.workspace.developer.nameLabel")}
              </Label>
              <Input
                dir="auto"
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                placeholder={t("settingsPage.workspace.developer.namePlaceholder")}
                required
              />
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {SCOPE_GROUPS_DEF.map((group) => (
                <div key={group.groupKey} className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                    {t(`settingsPage.workspace.developer.scopes.${group.groupKey}.title`)}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.scopes.map((s) => {
                      const checked = selectedScopes.has(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={checked}
                          onClick={() => toggleScope(s.id)}
                          className={cn(
                            "h-7 px-2.5 rounded-md border text-xs transition-colors outline-none",
                            "focus-visible:ring-1 focus-visible:ring-primary/30",
                            checked
                              ? "border-primary/40 bg-primary/8 text-foreground"
                              : "border-border/70 text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
                          )}
                        >
                          {t(
                            `settingsPage.workspace.developer.scopes.${group.groupKey}.${s.labelKey}`
                          )}
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
                {submitting && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                {submitting ? t("common.saving") : t("settingsPage.workspace.developer.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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

      <Dialog
        open={!!newKey}
        onOpenChange={(open) => {
          if (!open) replaceKey(null);
        }}
      >
        <DialogContent ref={bindSecret} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.workspace.developer.keyCreatedTitle")}</DialogTitle>
            <DialogDescription>
              {t("settingsPage.workspace.developer.keyCreatedDescription")}
            </DialogDescription>
          </DialogHeader>
          <div
            dir="ltr"
            className="rounded-md border border-border/70 bg-foreground/4 dark:bg-white/4 p-3 font-mono text-xs break-all"
          >
            {newKey?.key}
          </div>
          <DialogFooter>
            <Button onClick={handleCopy} variant="outline" size="sm">
              {copied ? (
                <>
                  <Check className="me-1.5 h-3.5 w-3.5" />
                  {t("common.copied")}
                </>
              ) : (
                <>
                  <Copy className="me-1.5 h-3.5 w-3.5" />
                  {t("common.copy")}
                </>
              )}
            </Button>
            <Button onClick={() => replaceKey(null)} size="sm">
              {t("common.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
