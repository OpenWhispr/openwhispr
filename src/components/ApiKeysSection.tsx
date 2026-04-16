import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Key, Copy, Check, Trash2, Plus, Shield, AlertTriangle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { useToast } from "./ui/useToast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  ConfirmDialog,
} from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { ApiKeysService } from "../services/ApiKeysService";
import type { ApiKey } from "../services/ApiKeysService";
import {
  API_SCOPES,
  API_SCOPE_I18N_KEY,
  API_KEY_EXPIRY_OPTIONS,
  MAX_API_KEYS,
  type ApiScope,
} from "../constants/apiKeys";

const MAX_NAME_LENGTH = 100;
const DEFAULT_EXPIRY_VALUE = "never";

function formatRelativeTime(dateString: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function ApiKeysSection() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

  const fetchKeys = useCallback(async () => {
    try {
      const { keys: fetched } = await ApiKeysService.list();
      setKeys(fetched);
    } catch (err) {
      console.error("Failed to load API keys:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await ApiKeysService.revoke(revokeTarget.id);
      toast({
        title: t("apiKeysSection.revoke.success"),
        variant: "success",
      });
      setRevokeTarget(null);
      await fetchKeys();
    } catch {
      toast({
        title: t("apiKeysSection.errors.revokeFailed"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionHeader
          title={t("apiKeysSection.title")}
          description={t("apiKeysSection.description")}
        />
        {!isLoading && keys.length > 0 && keys.length < MAX_API_KEYS && (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            {t("apiKeysSection.createButton")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <SettingsPanel>
          {[0, 1].map((i) => (
            <SettingsPanelRow key={i}>
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-8 w-16" />
              </div>
            </SettingsPanelRow>
          ))}
        </SettingsPanel>
      ) : keys.length === 0 ? (
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex flex-col items-center py-4 text-center">
              <Key className="h-5 w-5 text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground mb-3">{t("apiKeysSection.empty")}</p>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                {t("apiKeysSection.createButton")}
              </Button>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      ) : (
        <SettingsPanel>
          {keys.map((apiKey) => (
            <SettingsPanelRow key={apiKey.id}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-foreground truncate">
                      {apiKey.name}
                    </span>
                    <code className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
                      {apiKey.key_prefix}...
                    </code>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {apiKey.scopes.map((scope) => (
                      <Badge key={scope} variant="outline" className="text-[10px] px-1.5 py-0">
                        {t(
                          `apiKeysSection.scopes.${API_SCOPE_I18N_KEY[scope as ApiScope] ?? scope}`
                        )}
                      </Badge>
                    ))}
                    <span className="text-[10px] text-muted-foreground/50 ml-1">
                      {apiKey.last_used_at
                        ? t("apiKeysSection.lastUsed", {
                            time: formatRelativeTime(apiKey.last_used_at),
                          })
                        : t("apiKeysSection.neverUsed")}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setRevokeTarget(apiKey)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsPanelRow>
          ))}

          {keys.length >= MAX_API_KEYS && (
            <SettingsPanelRow>
              <p className="text-[10px] text-muted-foreground/50 text-center">
                {t("apiKeysSection.maxKeysReached", { max: MAX_API_KEYS })}
              </p>
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
        }}
        onCreated={fetchKeys}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t("apiKeysSection.revoke.confirm")}
        confirmText={t("apiKeysSection.revoke.button")}
        cancelText={t("apiKeysSection.create.cancel")}
        onConfirm={handleRevoke}
        variant="destructive"
      />
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(() => new Set(API_SCOPES));
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY_VALUE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const resetForm = () => {
    setName("");
    setScopes(new Set(API_SCOPES));
    setExpiry(DEFAULT_EXPIRY_VALUE);
    setIsSubmitting(false);
    setRawKey(null);
    setCopied(false);
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setRawKey(null);
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (!name.trim() || scopes.size === 0) return;
    setIsSubmitting(true);
    try {
      const expiresInDays = API_KEY_EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null;
      const result = await ApiKeysService.create({
        name: name.trim(),
        scopes: Array.from(scopes),
        expiresInDays,
      });
      setRawKey(result.key);
      await onCreated();
    } catch {
      toast({
        title: t("apiKeysSection.errors.createFailed"),
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!rawKey) return;
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      toast({
        title: t("apiKeysSection.created.copied"),
        variant: "success",
        duration: 2000,
      });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed — user can still manually select+copy
    }
  };

  const toggleScope = (scope: ApiScope) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        {rawKey ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-success" />
                {t("apiKeysSection.created.title")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("apiKeysSection.created.warning")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="rounded-lg border border-border/50 bg-muted/30 dark:bg-surface-raised/30 p-3">
                <code className="text-xs font-mono text-foreground break-all select-all leading-relaxed">
                  {rawKey}
                </code>
              </div>

              <Button variant="outline" size="sm" className="w-full" onClick={handleCopy}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 mr-1.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 mr-1.5" />
                )}
                {copied
                  ? t("apiKeysSection.created.copied")
                  : t("apiKeysSection.created.copyButton")}
              </Button>

              <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {t("apiKeysSection.created.warning")}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="default" size="sm" onClick={() => handleClose(false)}>
                {t("apiKeysSection.created.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("apiKeysSection.create.title")}</DialogTitle>
              <DialogDescription className="sr-only">
                {t("apiKeysSection.description")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t("apiKeysSection.create.nameLabel")}
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LENGTH))}
                  placeholder={t("apiKeysSection.create.namePlaceholder")}
                  className="h-9 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim() && scopes.size > 0) {
                      handleSubmit();
                    }
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t("apiKeysSection.create.scopesLabel")}
                </label>
                <div className="space-y-1">
                  {API_SCOPES.map((scope) => (
                    <label
                      key={scope}
                      className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 cursor-pointer hover:bg-muted/50 dark:hover:bg-surface-raised/30 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={scopes.has(scope)}
                        onChange={() => toggleScope(scope)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                      />
                      <span className="text-xs text-foreground">
                        {t(`apiKeysSection.scopes.${API_SCOPE_I18N_KEY[scope]}`)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t("apiKeysSection.create.expiryLabel")}
                </label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {API_KEY_EXPIRY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {t(`apiKeysSection.create.expiryOptions.${option.value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => handleClose(false)}>
                {t("apiKeysSection.create.cancel")}
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!name.trim() || scopes.size === 0 || isSubmitting}
                onClick={handleSubmit}
              >
                {isSubmitting ? (
                  <span className="flex items-center gap-1.5">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    {t("apiKeysSection.create.submit")}
                  </span>
                ) : (
                  t("apiKeysSection.create.submit")
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
