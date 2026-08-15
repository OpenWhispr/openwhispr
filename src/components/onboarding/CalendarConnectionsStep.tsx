import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileSearch, Loader2, MessageCircle, UsersRound } from "lucide-react";
import { Button } from "../ui/button";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.svg";
import appleCalendarIcon from "../../assets/icons/apple-calendar.svg";
import notesBackdrop from "../../assets/onboarding-notes-motion.webp";
import { BrandMark } from "./OnboardingShell";

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
      title: t("onboarding.rehaul.notes.connectors.googleTitle"),
      description: t("onboarding.rehaul.notes.connectors.googleDescription"),
      connected: store.gcalAccounts.length > 0,
    },
    {
      id: "microsoft" as const,
      icon: microsoftCalendarIcon,
      title: t("onboarding.rehaul.notes.connectors.microsoftTitle"),
      description: t("onboarding.rehaul.notes.connectors.microsoftDescription"),
      connected: store.mcalAccounts.length > 0,
    },
    ...(isMac
      ? [
          {
            id: "apple" as const,
            icon: appleCalendarIcon,
            title: t("onboarding.rehaul.notes.connectors.appleTitle"),
            description: t("onboarding.rehaul.notes.connectors.appleDescription"),
            connected: store.appleCalendarConnected,
          },
        ]
      : []),
  ];

  return (
    <div className="mx-auto mt-8 w-full max-w-[25rem] space-y-3">
      <section className="grid h-48 grid-cols-[2fr_3fr] overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div
          className="relative bg-cover bg-center"
          style={{ backgroundImage: `url(${notesBackdrop})` }}
        >
          <div className="absolute left-5 top-19 flex w-36 items-center gap-2 rounded-lg bg-neutral-950/80 p-2 text-white shadow-lg backdrop-blur-sm">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-500">
              <BrandMark className="size-5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[11px] font-medium">
                {t("onboarding.rehaul.notes.hero.detected")}
              </span>
              <span className="block truncate text-[9px] text-neutral-300">
                {t("onboarding.rehaul.notes.hero.transcribe")}
              </span>
            </span>
          </div>
        </div>

        <div className="p-3.5 text-left">
          <p className="text-[13px] font-medium leading-[1.35] text-neutral-950">
            {t("onboarding.rehaul.notes.hero.description")}
          </p>
          <ul className="mt-4 space-y-3 text-[11px] text-neutral-950">
            {[
              [MessageCircle, t("onboarding.rehaul.notes.hero.chat")],
              [FileSearch, t("onboarding.rehaul.notes.hero.transcript")],
              [UsersRound, t("onboarding.rehaul.notes.hero.speakers")],
            ].map(([Icon, label]) => (
              <li key={String(label)} className="flex items-center gap-2">
                <span className="flex size-4 items-center justify-center rounded-full bg-blue-50 text-blue-500">
                  <Icon className="size-2.5" />
                </span>
                {String(label)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 px-3">
        {providers.map((provider, index) => (
          <div
            key={provider.id}
            className={`flex h-16 items-center gap-3 ${index > 0 ? "border-t border-neutral-200" : ""}`}
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-neutral-200 bg-white">
              <img src={provider.icon} alt="" className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-neutral-950">{provider.title}</p>
              <p className="mt-0.5 truncate text-xs text-neutral-500">{provider.description}</p>
            </div>
            {provider.connected ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-blue-500 px-3 text-xs font-medium text-white">
                <CheckCircle2 className="size-3.5" />
                {t(
                  `integrations.${provider.id === "microsoft" ? "microsoftCalendar" : `${provider.id}Calendar`}.connected`
                )}
              </span>
            ) : (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={connecting !== null}
                onClick={() => void connect(provider.id)}
                className="h-7 rounded-full bg-neutral-950 px-3 text-xs text-white hover:bg-neutral-800"
              >
                {connecting === provider.id && <Loader2 className="size-3.5 animate-spin" />}
                {t("onboarding.rehaul.notes.connectors.connect")}
              </Button>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-center text-xs text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}
