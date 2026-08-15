import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";

type ProviderId = "google" | "microsoft" | "apple";

export default function CalendarConnectionsStep() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const systemAudio = useSystemAudioPermission();
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";

  const ensureSystemAudio = useCallback(async () => {
    if (systemAudio.granted || !canManageSystemAudioInApp(systemAudio)) return true;
    return systemAudio.request();
  }, [systemAudio]);

  const connect = useCallback(
    async (provider: ProviderId) => {
      setConnecting(provider);
      setError(null);
      try {
        if (!(await ensureSystemAudio())) {
          setError(t("onboarding.permissions.systemAudioDescription"));
          return;
        }

        if (provider === "google") {
          const result = await window.electronAPI?.gcalStartOAuth?.();
          if (result?.success && result.email) {
            const current = useSettingsStore.getState().gcalAccounts;
            store.setGcalAccounts([
              ...current.filter((account) => account.email !== result.email),
              { email: result.email },
            ]);
          } else if (!result?.error?.includes("access_denied")) {
            setError(t("integrations.googleCalendar.connectFailedDescription"));
          }
        } else if (provider === "microsoft") {
          const result = await window.electronAPI?.mcalStartOAuth?.();
          if (result?.success && result.email) {
            const current = useSettingsStore.getState().mcalAccounts;
            store.setMcalAccounts([
              ...current.filter((account) => account.email !== result.email),
              { email: result.email },
            ]);
          } else if (!result?.error?.includes("access_denied")) {
            setError(t("integrations.microsoftCalendar.connectFailedDescription"));
          }
        } else {
          const result = await window.electronAPI?.acalConnect?.();
          if (result?.success) store.setAppleCalendarConnected(true);
          else setError(t("integrations.appleCalendar.connectFailedDescription"));
        }
      } finally {
        setConnecting(null);
      }
    },
    [ensureSystemAudio, store, t]
  );

  useEffect(() => {
    const google = window.electronAPI?.onGcalConnectionChanged?.((data) => {
      if (data.accounts) store.setGcalAccounts(data.accounts);
    });
    const microsoft = window.electronAPI?.onMcalConnectionChanged?.((data) => {
      if (data.accounts) store.setMcalAccounts(data.accounts);
    });
    const apple = window.electronAPI?.onAcalConnectionChanged?.((data) => {
      store.setAppleCalendarConnected(data.connected);
    });
    return () => {
      google?.();
      microsoft?.();
      apple?.();
    };
  }, [store]);

  const providers = [
    {
      id: "google" as const,
      icon: googleCalendarIcon,
      title: t("integrations.googleCalendar.title"),
      description: t("integrations.googleCalendar.description"),
      connected: store.gcalAccounts.length > 0,
    },
    {
      id: "microsoft" as const,
      icon: microsoftCalendarIcon,
      title: t("integrations.microsoftCalendar.title"),
      description: t("integrations.microsoftCalendar.description"),
      connected: store.mcalAccounts.length > 0,
    },
    ...(isMac
      ? [
          {
            id: "apple" as const,
            icon: appleCalendarIcon,
            title: t("integrations.appleCalendar.title"),
            description: t("integrations.appleCalendar.description"),
            connected: store.appleCalendarConnected,
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto mt-6 w-full max-w-3xl space-y-6">
      <div className="onboarding-code-hero relative overflow-hidden rounded-3xl border border-border p-7 md:p-9">
        <div className="max-w-md rounded-2xl border border-border/60 bg-card/85 p-5 shadow-lg backdrop-blur">
          <p className="text-xs font-medium uppercase tracking-wider text-success">
            {t("onboarding.meeting.title")}
          </p>
          <p className="mt-2 text-lg font-medium text-foreground">
            {t("onboarding.meeting.autoDetect")}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {providers.map((provider, index) => (
          <div
            key={provider.id}
            className={`flex items-center gap-4 px-5 py-4 ${index > 0 ? "border-t border-border" : ""}`}
          >
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
              <img src={provider.icon} alt="" className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{provider.title}</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {provider.description}
              </p>
            </div>
            {provider.connected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
                <Check className="size-3.5" />
                {t(
                  `integrations.${provider.id === "microsoft" ? "microsoftCalendar" : `${provider.id}Calendar`}.connected`
                )}
              </span>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={connecting !== null}
                onClick={() => void connect(provider.id)}
                className="rounded-full"
              >
                {connecting === provider.id && <Loader2 className="size-3.5 animate-spin" />}
                {t(
                  `integrations.${provider.id === "microsoft" ? "microsoftCalendar" : `${provider.id}Calendar`}.connect`
                )}
              </Button>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
