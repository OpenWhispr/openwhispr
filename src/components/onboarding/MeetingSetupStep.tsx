import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { BellRing } from "lucide-react";
import { HotkeyInput } from "../ui/HotkeyInput";
import { useHotkeyRegistration } from "../../hooks/useHotkeyRegistration";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";

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

      <div className="flex items-center gap-3 rounded-md border border-border bg-surface-1 p-3">
        <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0">
          <BellRing className="w-4 h-4 text-primary" />
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
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
          value={meetingKey}
          onChange={async (newHotkey) => {
            await registerMeetingHotkey(newHotkey);
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
