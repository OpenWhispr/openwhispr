import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Code2, Info, Loader2, Mail, Plus, Unlink } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useSettingsStore } from "../stores/settingsStore";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import ApiKeysSection from "./ApiKeysSection";
import CliIntegrationCard from "./CliIntegrationCard";
import McpIntegrationCard from "./McpIntegrationCard";
import googleCalendarIcon from "../assets/icons/google-calendar.svg";

const API_DOCS_URL = "https://docs.openwhispr.com/api/overview";

interface IntegrationsViewProps {
  isPaid: boolean;
  onUpgrade: () => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-2 pl-1">
      {children}
    </div>
  );
}

export default function IntegrationsView({ isPaid, onUpgrade }: IntegrationsViewProps) {
  const { t } = useTranslation();
  const { gcalAccounts, setGcalAccounts } = useSettingsStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const [confirmDisconnectEmail, setConfirmDisconnectEmail] = useState<string | null>(null);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const [apiKeysDialogOpen, setApiKeysDialogOpen] = useState(false);
  const systemAudio = useSystemAudioPermission();
  const { request: requestSystemAudioAccess } = systemAudio;
  const hasAccounts = gcalAccounts.length > 0;
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);

  const startOAuth = useCallback(async () => {
    setIsConnecting(true);
    try {
      const result = await window.electronAPI?.gcalStartOAuth?.();
      if (result?.success && result.email) {
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts([
          ...current.filter((a) => a.email !== result.email),
          { email: result.email },
        ]);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [setGcalAccounts]);

  const handleConnect = useCallback(async () => {
    if (needsSystemAudioGrant) {
      const granted = await requestSystemAudioAccess();
      if (!granted) {
        setShowPermissionDialog(true);
        return;
      }
    }
    await startOAuth();
  }, [needsSystemAudioGrant, requestSystemAudioAccess, startOAuth]);

  const handleDisconnect = useCallback(
    async (email: string) => {
      setDisconnectingEmail(email);
      try {
        await window.electronAPI?.gcalDisconnect?.(email);
        const current = useSettingsStore.getState().gcalAccounts;
        setGcalAccounts(current.filter((a) => a.email !== email));
      } finally {
        setDisconnectingEmail(null);
      }
    },
    [setGcalAccounts]
  );

  useEffect(() => {
    const unsub = window.electronAPI?.onGcalConnectionChanged?.(
      (data: {
        accounts?: Array<{ email: string }>;
        connected?: boolean;
        email?: string | null;
      }) => {
        if (data.accounts) {
          setGcalAccounts(data.accounts);
        } else if (data.connected && data.email) {
          const current = useSettingsStore.getState().gcalAccounts;
          setGcalAccounts([
            ...current.filter((a) => a.email !== data.email),
            { email: data.email },
          ]);
        }
      }
    );
    return () => unsub?.();
  }, [setGcalAccounts]);

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("integrations.title")}</h2>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{t("integrations.description")}</p>
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.calendar")}</SectionLabel>
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
                <img src={googleCalendarIcon} alt="" className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold text-foreground">
                    {t("integrations.googleCalendar.title")}
                  </p>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                    {t("integrations.googleCalendar.optional")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                  {t("integrations.googleCalendar.description")}
                </p>
              </div>
              {!hasAccounts && (
                <Button
                  size="sm"
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="shrink-0"
                >
                  {isConnecting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t("integrations.googleCalendar.connect")
                  )}
                </Button>
              )}
              {hasAccounts && (
                <Badge variant="success" className="shrink-0">
                  {t("integrations.googleCalendar.connected")}
                </Badge>
              )}
            </div>
          </SettingsPanelRow>

          {hasAccounts &&
            gcalAccounts.map((account) => (
              <SettingsPanelRow key={account.email}>
                <div className="group flex items-center gap-3 pl-12">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  <span className="text-xs text-muted-foreground truncate flex-1">
                    {account.email}
                  </span>
                  <button
                    onClick={() => setConfirmDisconnectEmail(account.email)}
                    disabled={disconnectingEmail === account.email}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
                    aria-label={t("integrations.googleCalendar.disconnect")}
                  >
                    {disconnectingEmail === account.email ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Unlink className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </SettingsPanelRow>
            ))}

          {hasAccounts && (
            <SettingsPanelRow>
              <button
                onClick={handleConnect}
                disabled={isConnecting}
                className="flex items-center gap-2 pl-12 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
              >
                {isConnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {t("integrations.googleCalendar.addAnother")}
              </button>
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.api")}</SectionLabel>
        <SettingsPanel>
          <SettingsPanelRow>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
                <Code2 className="h-4 w-4 text-primary/80" strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground">
                  {t("integrations.api.title")}
                </p>
                <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                  {isPaid ? t("integrations.api.description") : t("integrations.api.proRequired")}
                </p>
              </div>
              {isPaid ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setApiKeysDialogOpen(true)}
                  className="shrink-0"
                >
                  {t("integrations.api.manage")}
                </Button>
              ) : (
                <Button size="sm" onClick={onUpgrade} className="shrink-0">
                  {t("integrations.api.viewPlans")}
                </Button>
              )}
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.mcp")}</SectionLabel>
        <McpIntegrationCard isPaid={isPaid} onUpgrade={onUpgrade} />
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.cli")}</SectionLabel>
        <CliIntegrationCard isPaid={isPaid} onUpgrade={onUpgrade} />
      </div>

      {!hasAccounts && (
        <div className="rounded-lg border border-border/40 dark:border-border-subtle/40 bg-muted/20 dark:bg-surface-2/30 p-4 flex items-start gap-3">
          <Info size={15} className="text-primary/60 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground/80">
              {t("integrations.notABot.title")}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
              {t("integrations.notABot.description")}
            </p>
          </div>
        </div>
      )}

      <Dialog open={apiKeysDialogOpen} onOpenChange={setApiKeysDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("integrations.api.dialogTitle")}</DialogTitle>
            <DialogDescription asChild>
              <span className="text-xs text-muted-foreground/80 leading-relaxed">
                {t("apiKeysSection.description")}
                <span className="mx-1.5 text-muted-foreground/30">·</span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-primary/80 hover:text-primary transition-colors"
                  onClick={() => window.electronAPI?.openExternal?.(API_DOCS_URL)}
                >
                  {t("apiKeysSection.docsLink")}
                </button>
              </span>
            </DialogDescription>
          </DialogHeader>
          <ApiKeysSection />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmDisconnectEmail(null);
        }}
        title={t("integrations.googleCalendar.disconnectConfirm", {
          email: confirmDisconnectEmail,
        })}
        description={t("integrations.googleCalendar.disconnectDescription")}
        confirmText={t("integrations.googleCalendar.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirmDisconnectEmail) handleDisconnect(confirmDisconnectEmail);
        }}
      />

      <ConfirmDialog
        open={showPermissionDialog}
        onOpenChange={setShowPermissionDialog}
        title={t("integrations.googleCalendar.systemAudioRequired")}
        description={t("integrations.googleCalendar.systemAudioDescription")}
        confirmText={
          systemAudio.mode === "native"
            ? t("integrations.googleCalendar.openSettings")
            : t("onboarding.permissions.grantAccess")
        }
        onConfirm={systemAudio.mode === "native" ? systemAudio.openSettings : systemAudio.request}
      />
    </div>
  );
}
