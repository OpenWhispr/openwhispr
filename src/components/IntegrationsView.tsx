import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Code2, Info, Loader2, Mail, Plus, Unlink } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import {
  AlertDialog,
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
import type { CalendarAccount } from "../types/calendar";
import ApiKeysSection from "./ApiKeysSection";
import CliIntegrationCard from "./CliIntegrationCard";
import McpIntegrationCard from "./McpIntegrationCard";
import googleCalendarIcon from "../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../assets/icons/apple-calendar.svg";

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

interface ProviderRowProps {
  icon: string;
  i18nKey: string;
  connected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
}

function ProviderRow({ icon, i18nKey, connected, isConnecting, onConnect }: ProviderRowProps) {
  const { t } = useTranslation();
  return (
    <SettingsPanelRow>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
          <img src={icon} alt="" className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold text-foreground">{t(`${i18nKey}.title`)}</p>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
              {t(`${i18nKey}.optional`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
            {t(`${i18nKey}.description`)}
          </p>
        </div>
        {connected ? (
          <Badge variant="success" className="shrink-0">
            {t(`${i18nKey}.connected`)}
          </Badge>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={isConnecting} className="shrink-0">
            {isConnecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t(`${i18nKey}.connect`)
            )}
          </Button>
        )}
      </div>
    </SettingsPanelRow>
  );
}

interface CalendarAccountRowsProps {
  i18nKey: string;
  accounts: CalendarAccount[];
  disconnectingEmail: string | null;
  onUnlink: (email: string) => void;
  primaryOnly: boolean;
  onPrimaryOnlyChange: (value: boolean) => void;
  isConnecting: boolean;
  onAddAnother: () => void;
}

function CalendarAccountRows({
  i18nKey,
  accounts,
  disconnectingEmail,
  onUnlink,
  primaryOnly,
  onPrimaryOnlyChange,
  isConnecting,
  onAddAnother,
}: CalendarAccountRowsProps) {
  const { t } = useTranslation();
  if (accounts.length === 0) return null;
  return (
    <>
      {accounts.map((account) => (
        <SettingsPanelRow key={account.email}>
          <div className="group flex items-center gap-3 pl-12">
            <Mail className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1">{account.email}</span>
            <button
              onClick={() => onUnlink(account.email)}
              disabled={disconnectingEmail === account.email}
              className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
              aria-label={t(`${i18nKey}.disconnect`)}
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

      <SettingsPanelRow>
        <SettingsRow
          label={t(`${i18nKey}.primaryOnly`)}
          description={t(`${i18nKey}.primaryOnlyDescription`)}
        >
          <Toggle checked={primaryOnly} onChange={onPrimaryOnlyChange} />
        </SettingsRow>
      </SettingsPanelRow>

      <SettingsPanelRow>
        <button
          onClick={onAddAnother}
          disabled={isConnecting}
          className="flex items-center gap-2 pl-12 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
        >
          {isConnecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t(`${i18nKey}.addAnother`)}
        </button>
      </SettingsPanelRow>
    </>
  );
}

export default function IntegrationsView({ isPaid, onUpgrade }: IntegrationsViewProps) {
  const { t } = useTranslation();
  const {
    gcalAccounts,
    setGcalAccounts,
    gcalPrimaryOnly,
    setGcalPrimaryOnly,
    mcalAccounts,
    setMcalAccounts,
    mcalPrimaryOnly,
    setMcalPrimaryOnly,
    appleCalendarConnected,
    setAppleCalendarConnected,
  } = useSettingsStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingEmail, setDisconnectingEmail] = useState<string | null>(null);
  const [confirmDisconnectEmail, setConfirmDisconnectEmail] = useState<string | null>(null);
  const [isMsConnecting, setIsMsConnecting] = useState(false);
  const [msDisconnectingEmail, setMsDisconnectingEmail] = useState<string | null>(null);
  const [confirmMsDisconnectEmail, setConfirmMsDisconnectEmail] = useState<string | null>(null);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const [isAppleConnecting, setIsAppleConnecting] = useState(false);
  const [appleSourceNames, setAppleSourceNames] = useState<string[]>([]);
  const [confirmAppleDisconnect, setConfirmAppleDisconnect] = useState(false);
  const [appleConnectError, setAppleConnectError] = useState<"denied" | "failed" | null>(null);
  const [apiKeysDialogOpen, setApiKeysDialogOpen] = useState(false);
  const systemAudio = useSystemAudioPermission();
  const { request: requestSystemAudioAccess } = systemAudio;
  const hasAccounts = gcalAccounts.length > 0;
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";

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

  const startMicrosoftOAuth = useCallback(async () => {
    setIsMsConnecting(true);
    try {
      const result = await window.electronAPI?.mcalStartOAuth?.();
      if (result?.success && result.email) {
        const current = useSettingsStore.getState().mcalAccounts;
        setMcalAccounts([
          ...current.filter((a) => a.email !== result.email),
          { email: result.email },
        ]);
      }
    } finally {
      setIsMsConnecting(false);
    }
  }, [setMcalAccounts]);

  const connectAppleCalendar = useCallback(async () => {
    setIsAppleConnecting(true);
    try {
      const result = await window.electronAPI?.acalConnect?.();
      if (result?.success) {
        setAppleCalendarConnected(true);
      } else {
        // Only send the user to Privacy settings when access was actually
        // denied; helper-missing/snapshot-failed are not permission problems.
        setAppleConnectError(result?.reason === "denied" ? "denied" : "failed");
      }
    } finally {
      setIsAppleConnecting(false);
    }
  }, [setAppleCalendarConnected]);

  const withSystemAudioGate = useCallback(
    async (connect: () => Promise<void>) => {
      if (needsSystemAudioGrant) {
        const granted = await requestSystemAudioAccess();
        if (!granted) {
          setShowPermissionDialog(true);
          return;
        }
      }
      await connect();
    },
    [needsSystemAudioGrant, requestSystemAudioAccess]
  );

  const handleConnect = useCallback(
    () => withSystemAudioGate(startOAuth),
    [withSystemAudioGate, startOAuth]
  );

  const handleMicrosoftConnect = useCallback(
    () => withSystemAudioGate(startMicrosoftOAuth),
    [withSystemAudioGate, startMicrosoftOAuth]
  );

  const handleAppleConnect = useCallback(
    () => withSystemAudioGate(connectAppleCalendar),
    [withSystemAudioGate, connectAppleCalendar]
  );

  const handleAppleDisconnect = useCallback(async () => {
    await window.electronAPI?.acalDisconnect?.();
    setAppleCalendarConnected(false);
    setAppleSourceNames([]);
  }, [setAppleCalendarConnected]);

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

  const handleMicrosoftDisconnect = useCallback(
    async (email: string) => {
      setMsDisconnectingEmail(email);
      try {
        await window.electronAPI?.mcalDisconnect?.(email);
        const current = useSettingsStore.getState().mcalAccounts;
        setMcalAccounts(current.filter((a) => a.email !== email));
      } finally {
        setMsDisconnectingEmail(null);
      }
    },
    [setMcalAccounts]
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

  useEffect(() => {
    const unsub = window.electronAPI?.onMcalConnectionChanged?.(
      (data: { accounts?: Array<{ email: string }> }) => {
        if (data.accounts) setMcalAccounts(data.accounts);
      }
    );
    return () => unsub?.();
  }, [setMcalAccounts]);

  useEffect(() => {
    if (!isMac) return;
    window.electronAPI?.acalGetConnectionStatus?.().then((status) => {
      if (status) {
        setAppleCalendarConnected(status.connected);
        setAppleSourceNames(status.sourceNames);
      }
    });
    const unsub = window.electronAPI?.onAcalConnectionChanged?.((data) => {
      setAppleCalendarConnected(data.connected);
      setAppleSourceNames(data.sourceNames ?? []);
    });
    return () => unsub?.();
  }, [isMac, setAppleCalendarConnected]);

  return (
    <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t("integrations.title")}</h2>
        <p className="text-xs text-muted-foreground/70 mt-0.5">{t("integrations.description")}</p>
      </div>

      <div>
        <SectionLabel>{t("integrations.sections.calendar")}</SectionLabel>
        <SettingsPanel>
          <ProviderRow
            icon={googleCalendarIcon}
            i18nKey="integrations.googleCalendar"
            connected={hasAccounts}
            isConnecting={isConnecting}
            onConnect={handleConnect}
          />
          <CalendarAccountRows
            i18nKey="integrations.googleCalendar"
            accounts={gcalAccounts}
            disconnectingEmail={disconnectingEmail}
            onUnlink={setConfirmDisconnectEmail}
            primaryOnly={gcalPrimaryOnly}
            onPrimaryOnlyChange={setGcalPrimaryOnly}
            isConnecting={isConnecting}
            onAddAnother={handleConnect}
          />

          <ProviderRow
            icon={microsoftCalendarIcon}
            i18nKey="integrations.microsoftCalendar"
            connected={mcalAccounts.length > 0}
            isConnecting={isMsConnecting}
            onConnect={handleMicrosoftConnect}
          />
          <CalendarAccountRows
            i18nKey="integrations.microsoftCalendar"
            accounts={mcalAccounts}
            disconnectingEmail={msDisconnectingEmail}
            onUnlink={setConfirmMsDisconnectEmail}
            primaryOnly={mcalPrimaryOnly}
            onPrimaryOnlyChange={setMcalPrimaryOnly}
            isConnecting={isMsConnecting}
            onAddAnother={handleMicrosoftConnect}
          />

          {isMac && (
            <ProviderRow
              icon={appleCalendarIcon}
              i18nKey="integrations.appleCalendar"
              connected={appleCalendarConnected}
              isConnecting={isAppleConnecting}
              onConnect={handleAppleConnect}
            />
          )}

          {isMac && appleCalendarConnected && (
            <SettingsPanelRow>
              <div className="group flex items-center gap-3 pl-12">
                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                <span className="text-xs text-muted-foreground truncate flex-1">
                  {appleSourceNames.join(" · ")}
                </span>
                <button
                  onClick={() => setConfirmAppleDisconnect(true)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                  aria-label={t("integrations.appleCalendar.disconnect")}
                >
                  <Unlink className="h-3.5 w-3.5" />
                </button>
              </div>
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
        open={!!confirmMsDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmMsDisconnectEmail(null);
        }}
        title={t("integrations.microsoftCalendar.disconnectConfirm", {
          email: confirmMsDisconnectEmail,
        })}
        description={t("integrations.microsoftCalendar.disconnectDescription")}
        confirmText={t("integrations.microsoftCalendar.disconnect")}
        variant="destructive"
        onConfirm={() => {
          if (confirmMsDisconnectEmail) handleMicrosoftDisconnect(confirmMsDisconnectEmail);
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

      <ConfirmDialog
        open={confirmAppleDisconnect}
        onOpenChange={setConfirmAppleDisconnect}
        title={t("integrations.appleCalendar.disconnectConfirm")}
        description={t("integrations.appleCalendar.disconnectDescription")}
        confirmText={t("integrations.appleCalendar.disconnect")}
        variant="destructive"
        onConfirm={handleAppleDisconnect}
      />

      <ConfirmDialog
        open={appleConnectError === "denied"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.permissionDenied")}
        description={t("integrations.appleCalendar.permissionDeniedDescription")}
        confirmText={t("integrations.appleCalendar.openSettings")}
        onConfirm={() => window.electronAPI?.openCalendarPrivacySettings?.()}
      />

      <AlertDialog
        open={appleConnectError === "failed"}
        onOpenChange={(open) => !open && setAppleConnectError(null)}
        title={t("integrations.appleCalendar.connectFailed")}
        description={t("integrations.appleCalendar.connectFailedDescription")}
        onOk={() => {}}
      />
    </div>
  );
}
