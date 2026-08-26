import { useCallback, useEffect, useState } from "react";
import { CircleCheck, FileSearch, Loader2, MessageCircle, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import googleCalendarIcon from "../../assets/icons/google-calendar.svg";
import microsoftCalendarIcon from "../../assets/icons/microsoft-calendar.webp";
import appleCalendarIcon from "../../assets/icons/apple-calendar.webp";
import meetingDetectedPanel from "../../assets/onboarding-notes-meeting-detected.webp";

type ProviderId = "google" | "microsoft" | "apple";

export default function CalendarConnectionsStep() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const systemAudio = useSystemAudioPermission();
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleDenied, setAppleDenied] = useState(false);
  const isMac = window.electronAPI?.getPlatform?.() === "darwin";

  const ensureSystemAudio = useCallback(async () => {
    if (systemAudio.granted || !canManageSystemAudioInApp(systemAudio)) return true;
    return systemAudio.request();
  }, [systemAudio]);

  const connect = useCallback(
    async (provider: ProviderId) => {
      setConnecting(provider);
      setError(null);
      setAppleDenied(false);
      try {
        // Recording a meeting needs system audio; connecting a calendar does not.
        // Awaited so the permission dialog doesn't race the OAuth browser window,
        // but a denial no longer aborts the connection — that left a user who
        // declined the prompt unable to connect any calendar at all.
        await ensureSystemAudio();

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
          if (result?.success) {
            store.setAppleCalendarConnected(true);
          } else if (result?.reason === "denied") {
            // Same distinction IntegrationsView draws: only a real permission
            // denial sends the user to Privacy settings; helper-missing /
            // snapshot-failed are not permission problems.
            setAppleDenied(true);
            setError(t("integrations.appleCalendar.permissionDeniedDescription"));
          } else {
            setError(t("integrations.appleCalendar.connectFailedDescription"));
          }
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
    // Figma: Onboarding / Frame 2147203458 — column, hugging its content. Sizes
    // tightened from the spec so all three provider rows fit without scrolling.
    <div className="flex w-full flex-col items-center gap-2.5">
      {/* The original two-panel artwork is kept proportional inside the denser
          onboarding frame. */}
      <section className="flex h-44 w-full max-w-[26rem] overflow-hidden rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)]">
        {/* Frame 2147258992 — 198x245 export, cropped by object-cover. NOTE: it
            was composited for the right-hand slot, so its bleed runs off the
            artwork's right edge — now the card's inner edge. It needs
            re-exporting with the bleed on the left. */}
        <img
          src={meetingDetectedPanel}
          alt=""
          aria-hidden="true"
          width={198}
          height={220}
          decoding="async"
          draggable={false}
          className="h-44 w-40 shrink-0 select-none object-cover"
        />

        {/* Flexible copy panel beside the fixed-aspect artwork. */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 bg-[var(--onboarding-surface)] px-3.5 py-4 text-left">
          <p className="text-xs font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
            {t("onboarding.rehaul.notes.hero.description")}
          </p>
          {/* Frame 2147258993 — 227 wide, col gap 14; rows are gap 6, 18px marks. */}
          <ul className="flex flex-col gap-2.5">
            {[
              [MessageCircle, t("onboarding.rehaul.notes.hero.chat")],
              [FileSearch, t("onboarding.rehaul.notes.hero.transcript")],
              [UsersRound, t("onboarding.rehaul.notes.hero.speakers")],
            ].map(([Icon, label]) => (
              <li
                key={String(label)}
                className="flex items-center gap-1.5 text-xs leading-[1.32] text-[var(--onboarding-text-primary)]"
              >
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--onboarding-accent)_8%,transparent)] text-[var(--onboarding-accent)]">
                  <Icon className="size-2.5" strokeWidth={0.833} />
                </span>
                {String(label)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Frame 16 — 498 wide, radius 17. The spec's #F7F7F7 comes from the
          token, not a literal: hardcoded, the card stayed near-white in dark
          mode while the text tokens flipped light and the provider names
          vanished. Rows: no padding above the first, none below the last,
          hairline dividers between. */}
      <div className="w-full max-w-[26rem] rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-3.5 py-3">
        {providers.map((provider, index) => (
          <div
            key={provider.id}
            className={`flex items-center gap-[14px] ${
              index === 0
                ? "pb-2.5"
                : "border-t border-[var(--onboarding-control-border)] py-2.5 last:pb-0"
            }`}
          >
            {/* Frame 2147258981 — 44x44 tile, 1px surface stroke, rx 9.5, with a 24px
                glyph inset. The stroke lives here rather than in each asset so all
                three providers match; the 48px sources land exactly 2x at 24px.
                No fill: the frame has stroke only, so the row's surface reads
                through. Do not re-add bg-[var(--onboarding-surface)]. */}
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-[var(--onboarding-control-border)]">
              <img
                src={provider.icon}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
                decoding="async"
                draggable={false}
                // contain, not cover: the Microsoft export is 51x48, so it
                // letterboxes instead of stretching.
                className="size-5 select-none object-contain"
              />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-[3px] text-left">
              <p className="text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
                {provider.title}
              </p>
              <p className="truncate text-xs leading-[1.4] text-[var(--onboarding-text-secondary)]">
                {provider.description}
              </p>
            </div>
            {/* Figma "Frame 25", both states: pad 6 14, radius 38, 14/140% medium
                white. Deliberately a plain button, not the shadcn Button — that
                default variant layers on shadow-sm, hover:shadow, a
                border-primary/60 and font-semibold, none of which the spec has. */}
            {provider.connected ? (
              <span className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[38px] bg-[var(--onboarding-accent)] px-3 py-1.5 text-xs font-medium leading-[1.4] text-[var(--onboarding-accent-foreground)]">
                <CircleCheck className="size-3.5 shrink-0" strokeWidth={1.167} />
                {t(`integrations.${provider.id}Calendar.connected`)}
              </span>
            ) : (
              <button
                type="button"
                disabled={connecting !== null}
                onClick={() => void connect(provider.id)}
                className="onboarding-pressable inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[38px] bg-[var(--onboarding-inverse-surface)] px-3 py-1.5 text-xs font-medium leading-[1.4] text-[var(--onboarding-inverse-text)] hover:bg-[var(--onboarding-inverse-surface-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)] disabled:cursor-default disabled:opacity-60"
              >
                {connecting === provider.id && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                )}
                {t("onboarding.rehaul.notes.connectors.connect")}
              </button>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-center text-xs text-[var(--onboarding-danger)]">
          {error}
          {appleDenied && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => void window.electronAPI?.openCalendarPrivacySettings?.()}
                className="font-medium underline underline-offset-2 hover:opacity-70"
              >
                {t("integrations.appleCalendar.openSettings")}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
