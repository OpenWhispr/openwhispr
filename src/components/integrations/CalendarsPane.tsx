import { useState, useEffect, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, Loader2, Mail, Plus, Unlink } from "../icons";
import { Button } from "../ui/button";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { Badge } from "../ui/badge";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { AlertDialog, ConfirmDialog } from "../ui/dialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import type { CalendarAccount, MicrosoftCalendarAccount } from "../../types/calendar";
import { IntegrationsPane } from "./IntegrationsPane";
import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";

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
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10 flex items-center justify-center shrink-0">
          <img src={icon} alt="" className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground">{t(`${i18nKey}.title`)}</p>
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
          <div className="group flex items-center gap-3 ps-12">
            <Mail className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
            <span className="text-xs text-muted-foreground truncate flex-1">
              <bdi dir="ltr">{account.email}</bdi>
            </span>
            <button
              onClick={() => onUnlink(account.email)}
              disabled={disconnectingEmail === account.email}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
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
          <Toggle
            ariaLabel={t(`${i18nKey}.primaryOnly`)}
            checked={primaryOnly}
            onChange={onPrimaryOnlyChange}
          />
        </SettingsRow>
      </SettingsPanelRow>

      <SettingsPanelRow>
        <button
          onClick={onAddAnother}
          disabled={isConnecting}
          className="flex items-center gap-2 ps-12 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
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

interface CalendarsPaneProps {
  title: string;
}

export function CalendarsPane({ title }: CalendarsPaneProps): ReactElement {
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
  // i18n prefix of the provider whose OAuth flow failed, e.g. "integrations.googleCalendar"
  const [oauthErrorKey, setOauthErrorKey] = useState<string | null>(null);
  const systemAudio = useSystemAudioPermission();
  const { request: requestSystemAudioAccess } = systemAudio;
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
      } else if (!result?.error?.includes("access_denied")) {
        // access_denied means the user cancelled on the consent screen
        setOauthErrorKey("integrations.googleCalendar");
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
          { email: result.email, tenantId: result.tenantId },
        ]);
      } else if (!result?.error?.includes("access_denied")) {
        setOauthErrorKey("integrations.microsoftCalendar");
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
      (data: { accounts?: MicrosoftCalendarAccount[] }) => {
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
    <IntegrationsPane title={title} description={t("integrations.notABot.description")}>
      <SettingsPanel>
        <ProviderRow
          icon={googleCalendarIcon}
          i18nKey="integrations.googleCalendar"
          connected={gcalAccounts.length > 0}
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
            <div className="group flex items-center gap-3 ps-12">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
              <span className="text-xs text-muted-foreground truncate flex-1">
                {appleSourceNames.join(" · ")}
              </span>
              <button
                onClick={() => setConfirmAppleDisconnect(true)}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                aria-label={t("integrations.appleCalendar.disconnect")}
              >
                <Unlink className="h-3.5 w-3.5" />
              </button>
            </div>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      <ConfirmDialog
        open={!!confirmDisconnectEmail}
        onOpenChange={(open) => {
          if (!open) setConfirmDisconnectEmail(null);
        }}
        title={
          <BidiInterpolatedText
            text={t("integrations.googleCalendar.disconnectConfirm", {
              email: BIDI_VALUE_TOKEN,
            })}
            value={confirmDisconnectEmail}
          />
        }
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
        title={
          <BidiInterpolatedText
            text={t("integrations.microsoftCalendar.disconnectConfirm", {
              email: BIDI_VALUE_TOKEN,
            })}
            value={confirmMsDisconnectEmail}
          />
        }
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

      <AlertDialog
        open={!!oauthErrorKey}
        onOpenChange={(open) => !open && setOauthErrorKey(null)}
        title={oauthErrorKey ? t(`${oauthErrorKey}.connectFailed`) : ""}
        description={oauthErrorKey ? t(`${oauthErrorKey}.connectFailedDescription`) : ""}
        onOk={() => {}}
      />
    </IntegrationsPane>
  );
}
