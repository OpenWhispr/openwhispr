import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, Info, Loader2, Mail, Plus, Unlink } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { ConfirmDialog } from "./ui/dialog";
import { useSettingsStore } from "../stores/settingsStore";
import { useScreenRecordingPermission } from "../hooks/useScreenRecordingPermission";
import googleCalendarIcon from "../assets/icons/google-calendar.svg";

export default function IntegrationsView() {
  const { t } = useTranslation();
  const { gcalAccounts, setGcalAccounts } = useSettingsStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const [confirmDisconnectEmail, setConfirmDisconnectEmail] = useState<string | null>(null);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const screenRecording = useScreenRecordingPermission();
  const hasAccounts = gcalAccounts.length > 0;

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
    if (screenRecording.isMacOS && !screenRecording.granted) {
      setShowPermissionDialog(true);
      return;
    }
    await startOAuth();
  }, [screenRecording.isMacOS, screenRecording.granted, startOAuth]);

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
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("integrations.title")}</h2>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{t("integrations.description")}</p>
      </div>

      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
              <img src={googleCalendarIcon} alt="" className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {t("integrations.googleCalendar.title")}
              </p>
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

      <div className="rounded-lg border border-border/40 dark:border-border-subtle/40 bg-muted/20 dark:bg-surface-2/30 p-4 flex items-start gap-3">
        <FlaskConical size={15} className="text-primary/60 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground/80">{t("integrations.beta.title")}</p>
          <p className="text-xs text-muted-foreground/60 mt-0.5 leading-relaxed">
            {t("integrations.beta.description")}
          </p>
          <div className="mt-2 space-y-1">
            <p className="text-xs text-muted-foreground/60">{t("integrations.beta.freeTier")}</p>
            <p className="text-xs text-muted-foreground/60">{t("integrations.beta.proTier")}</p>
          </div>
          <p className="text-xs text-muted-foreground/50 mt-2 leading-relaxed">
            {t("integrations.beta.feedback")}
          </p>
        </div>
      </div>

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
        title={t("integrations.googleCalendar.screenRecordingRequired")}
        description={t("integrations.googleCalendar.screenRecordingDescription")}
        confirmText={t("integrations.googleCalendar.openSettings")}
        onConfirm={screenRecording.openSettings}
      />
    </div>
  );
}
