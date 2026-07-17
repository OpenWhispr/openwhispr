import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MeetingNotificationCard } from "../MeetingNotificationCard";
import { HotkeyInput } from "../ui/HotkeyInput";
import { useHotkeyRegistration } from "../../hooks/useHotkeyRegistration";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";
import { parseHotkeyList, serializeHotkeyList } from "../../utils/hotkeys";

interface MeetingSetupStepProps {
  meetingKey: string;
  setMeetingKey: (key: string) => void;
  dictationKey: string;
}

export default function MeetingSetupStep({
  meetingKey,
  setMeetingKey,
  dictationKey,
}: MeetingSetupStepProps) {
  const { t } = useTranslation();

  const meetingRegisterFn = useCallback(async (hotkey: string) => {
    const result = await window.electronAPI?.registerMeetingHotkey?.(hotkey);
    return result ?? { success: false, message: "Electron API unavailable" };
  }, []);

  const { registerHotkey: registerMeetingHotkey, isRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setMeetingKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    registerFn: meetingRegisterFn,
  });

  const validateMeetingHotkey = useCallback(
    (hotkey: string) =>
      validateHotkeyForSlot(hotkey, { "settingsPage.general.hotkey.title": dictationKey }, t),
    [dictationKey, t]
  );

  return (
    <div className="space-y-4">
      <div className="text-center space-y-0.5">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.meeting.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("onboarding.meeting.description")}</p>
      </div>

      <div className="space-y-2">
        {/* A faithful preview of the real notification, framed like a desktop corner */}
        <div className="relative overflow-hidden rounded-lg border border-border-subtle bg-gradient-to-br from-surface-2/50 via-surface-1 to-primary/5 px-4 pt-4 pb-9">
          <div className="pointer-events-none select-none">
            <MeetingNotificationCard
              title={t("meetingNotification.title")}
              body={t("meetingNotification.body.detected")}
              startLabel={t("meetingNotification.start")}
              className="ml-auto w-full max-w-[300px] shadow-xl"
            />
          </div>
        </div>
        <p className="px-2 text-center text-xs text-muted-foreground/80 leading-snug">
          {t("onboarding.meeting.autoDetect")}
        </p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-surface-1 p-4">
        <div className="mb-3">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("onboarding.meeting.hotkeyLabel")}
          </span>
          <p className="text-xs text-muted-foreground/70 mt-0.5">
            {t("onboarding.meeting.hotkeyHint")}
          </p>
        </div>
        <HotkeyInput
          value={parseHotkeyList(meetingKey)[0] ?? ""}
          onChange={async (newHotkey) => {
            // Edits the primary meeting hotkey; extra bindings are preserved.
            await registerMeetingHotkey(
              serializeHotkeyList([newHotkey, ...parseHotkeyList(meetingKey).slice(1)])
            );
          }}
          disabled={isRegistering}
          validate={validateMeetingHotkey}
        />
        {meetingKey && (
          <button
            onClick={async () => {
              await window.electronAPI?.registerMeetingHotkey?.("");
              setMeetingKey("");
            }}
            disabled={isRegistering}
            className="mt-2 text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t("settingsPage.general.meetingHotkey.clear")}
          </button>
        )}
      </div>
    </div>
  );
}
