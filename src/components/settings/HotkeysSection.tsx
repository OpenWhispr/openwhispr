import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useHotkeyRegistration } from "../../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { useSettingsStore, type HotkeyRegistrationResult } from "../../stores/settingsStore";
import { usePolicyStore } from "../../stores/policyStore";
import { isAgentAllowed } from "../../stores/policyRules";
import { validateHotkeyForSlot } from "../../utils/hotkeyValidation";
import { getCachedPlatform } from "../../utils/platform";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import logger from "../../utils/logger";
import { Info } from "../icons";
import { Alert, AlertTitle, AlertDescription } from "../ui/alert";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { HotkeyListInput } from "../ui/HotkeyListInput";
import { ActivationModeSelector } from "../ui/ActivationModeSelector";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPanel, SettingsPanelRow, SectionHeader } from "../ui/SettingsSection";
import { KeepAlive } from "./KeepAlive";

interface Props {
  active: boolean;
  linuxPttAvailable: boolean;
  showAlertDialog: (options: { title: string; description?: string }) => void;
}

const meetingRegisterFn = async (hotkey: string) => {
  const result = await window.electronAPI?.registerMeetingHotkey?.(hotkey);
  // Omit message so useHotkeyRegistration uses its translated failure text.
  return result ?? { success: false };
};

function HotkeysControls({ active, linuxPttAvailable, showAlertDialog }: Props) {
  const { t } = useTranslation();
  const {
    dictationKey,
    setDictationKey,
    meetingKey,
    setMeetingKey,
    voiceAgentKey,
    setVoiceAgentKey,
    translationKey,
    setTranslationKey,
    activationMode,
    setActivationMode,
    meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode,
  } = useSettingsStore(
    useShallow((settings) => ({
      dictationKey: settings.dictationKey,
      setDictationKey: settings.setDictationKey,
      meetingKey: settings.meetingKey,
      setMeetingKey: settings.setMeetingKey,
      voiceAgentKey: settings.voiceAgentKey,
      setVoiceAgentKey: settings.setVoiceAgentKey,
      translationKey: settings.translationKey,
      setTranslationKey: settings.setTranslationKey,
      activationMode: settings.activationMode,
      setActivationMode: settings.setActivationMode,
      meetingHotkeyLayoutMode: settings.meetingHotkeyLayoutMode,
      setMeetingHotkeyLayoutMode: settings.setMeetingHotkeyLayoutMode,
    }))
  );
  const agentAllowedByPolicy = usePolicyStore(isAgentAllowed);
  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const { registerHotkey: registerMeetingHotkey, isRegistering: isMeetingHotkeyRegistering } =
    useHotkeyRegistration({
      onSuccess: (registeredHotkey) => {
        setMeetingKey(registeredHotkey);
      },
      showSuccessToast: false,
      showErrorToast: true,
      showAlert: showAlertDialog,
      registerFn: meetingRegisterFn,
    });

  // Preserve main's translated failure and return a boolean so HotkeyListInput
  // rolls an unsuccessful registration back.
  const [isAgentHotkeyCommitting, setIsAgentHotkeyCommitting] = useState(false);
  const commitAgentHotkey = async (
    setter: (key: string) => Promise<HotkeyRegistrationResult>,
    key: string
  ) => {
    setIsAgentHotkeyCommitting(true);
    try {
      const result = await setter(key);
      if (!result.success) {
        showAlertDialog({
          title: t("hooks.hotkeyRegistration.titles.notRegistered"),
          description: result.message || t("hooks.hotkeyRegistration.errors.failedToRegister"),
        });
      }
      return result.success;
    } finally {
      setIsAgentHotkeyCommitting(false);
    }
  };

  const validateDictationHotkey = (hotkey: string) =>
    validateHotkeyForSlot(
      hotkey,
      {
        "settingsPage.general.meetingHotkey.title": meetingKey,
        "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
        "settingsPage.general.translationHotkey.title": translationKey,
      },
      t
    );

  const validateMeetingHotkey = (hotkey: string) =>
    validateHotkeyForSlot(
      hotkey,
      {
        "settingsPage.general.hotkey.title": dictationKey,
        "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
        "settingsPage.general.translationHotkey.title": translationKey,
      },
      t
    );

  const validateVoiceAgentHotkey = (hotkey: string) =>
    validateHotkeyForSlot(
      hotkey,
      {
        "settingsPage.general.hotkey.title": dictationKey,
        "settingsPage.general.meetingHotkey.title": meetingKey,
        "settingsPage.general.translationHotkey.title": translationKey,
      },
      t
    );

  const validateTranslationHotkey = (hotkey: string) =>
    validateHotkeyForSlot(
      hotkey,
      {
        "settingsPage.general.hotkey.title": dictationKey,
        "settingsPage.general.meetingHotkey.title": meetingKey,
        "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
      },
      t
    );

  const {
    isUsingNativeShortcut,
    isUsingHyprland,
    hyprlandConfigStatus,
    pushToTalkUnavailableReason,
    linuxInputAccessDenied,
  } = useHotkeyModeInfo("settings", dictationKey);
  const [effectiveDefaultHotkey, setEffectiveDefaultHotkey] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let current = true;
    const loadEffectiveDefaultHotkey = async () => {
      try {
        const key = await window.electronAPI?.getEffectiveDefaultHotkey?.();
        if (current && key) setEffectiveDefaultHotkey(key);
      } catch (error) {
        if (current) logger.error("Failed to get effective default hotkey", error, "settings");
      }
    };
    void loadEffectiveDefaultHotkey();
    return () => {
      current = false;
    };
  }, [active]);

  // Keep registration ownership, but not key-capture controls, alive on section exit.
  if (!active) return null;

  return (
    <div className="space-y-6">
      {isUsingHyprland && hyprlandConfigStatus && !hyprlandConfigStatus.canWrite && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>
            {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningTitle")}
          </AlertTitle>
          <AlertDescription>
            <BidiInterpolatedText
              text={t("settingsPage.general.hotkey.hyprlandConfigWriteWarningDescription", {
                path: BIDI_VALUE_TOKEN,
              })}
              value={hyprlandConfigStatus.path}
            />
          </AlertDescription>
        </Alert>
      )}
      {/* Dictation Hotkey */}
      <div>
        <SectionHeader
          title={t("settingsPage.general.hotkey.title")}
          description={t("settingsPage.general.hotkey.description")}
          note={isUsingHyprland && t("settingsPage.general.hotkey.hyprlandUnbindDescription")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <HotkeyListInput
              ariaLabel={t("settingsPage.general.hotkey.title")}
              value={dictationKey}
              onChange={(list) => registerHotkey(list)}
              validate={validateDictationHotkey}
              disabled={isHotkeyRegistering}
              maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
              required
              footerEnd={
                effectiveDefaultHotkey &&
                dictationKey &&
                dictationKey !== effectiveDefaultHotkey ? (
                  <button
                    onClick={() => registerHotkey(effectiveDefaultHotkey)}
                    disabled={isHotkeyRegistering}
                    className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <BidiInterpolatedText
                      text={t("settingsPage.general.hotkey.resetToDefault", {
                        hotkey: BIDI_VALUE_TOKEN,
                      })}
                      value={formatHotkeyLabel(effectiveDefaultHotkey)}
                    />
                  </button>
                ) : null
              }
            />
          </SettingsPanelRow>

          {(!isUsingNativeShortcut || getCachedPlatform() === "linux") && (
            <SettingsPanelRow>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground/80">
                  {t("settingsPage.general.hotkey.activationMode")}
                </span>
                <ActivationModeSelector
                  value={activationMode}
                  onChange={setActivationMode}
                  pushDisabledReason={pushToTalkUnavailableReason ?? undefined}
                />
              </div>
              {/* Denied input access gets the setup box below instead. */}
              {pushToTalkUnavailableReason && !linuxInputAccessDenied && (
                <p className="mt-2 text-xs text-muted-foreground">{pushToTalkUnavailableReason}</p>
              )}
              {getCachedPlatform() === "linux" &&
                (activationMode === "push" || linuxInputAccessDenied) && (
                  <LinuxPttSetupInfo isAvailable={!linuxInputAccessDenied && linuxPttAvailable} />
                )}
            </SettingsPanelRow>
          )}
        </SettingsPanel>
      </div>

      {/* Voice Agent Hotkey */}
      {agentAllowedByPolicy && (
        <div>
          <SectionHeader
            title={t("settingsPage.general.voiceAgentHotkey.title")}
            description={t("settingsPage.general.voiceAgentHotkey.description")}
          />
          <SettingsPanel>
            <SettingsPanelRow>
              <HotkeyListInput
                ariaLabel={t("settingsPage.general.voiceAgentHotkey.title")}
                value={voiceAgentKey}
                onChange={(list) => commitAgentHotkey(setVoiceAgentKey, list)}
                onClear={() => commitAgentHotkey(setVoiceAgentKey, "")}
                validate={validateVoiceAgentHotkey}
                disabled={isAgentHotkeyCommitting}
                maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
              />
            </SettingsPanelRow>
          </SettingsPanel>
        </div>
      )}

      {/* Translation Hotkey */}
      <div>
        <SectionHeader
          title={t("settingsPage.general.translationHotkey.title")}
          description={t("settingsPage.general.translationHotkey.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <HotkeyListInput
              ariaLabel={t("settingsPage.general.translationHotkey.title")}
              value={translationKey}
              onChange={(list) => commitAgentHotkey(setTranslationKey, list)}
              onClear={() => commitAgentHotkey(setTranslationKey, "")}
              validate={validateTranslationHotkey}
              disabled={isAgentHotkeyCommitting}
              maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
            />
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      {/* Meeting Mode Hotkey */}
      <div>
        <SectionHeader
          title={t("settingsPage.general.meetingHotkey.title")}
          description={t("settingsPage.general.meetingHotkey.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <HotkeyListInput
              ariaLabel={t("settingsPage.general.meetingHotkey.title")}
              value={meetingKey}
              onChange={(list) => registerMeetingHotkey(list)}
              onClear={async (): Promise<boolean> => {
                try {
                  const result = await window.electronAPI?.registerMeetingHotkey?.("");
                  if (result?.success) {
                    setMeetingKey("");
                    return true;
                  }
                  showAlertDialog({
                    title: t("hooks.hotkeyRegistration.titles.notRegistered"),
                    description:
                      result?.message || t("hooks.hotkeyRegistration.errors.couldNotRegister"),
                  });
                } catch {
                  showAlertDialog({
                    title: t("hooks.hotkeyRegistration.titles.notRegistered"),
                    description: t("hooks.hotkeyRegistration.errors.couldNotRegister"),
                  });
                }
                return false;
              }}
              validate={validateMeetingHotkey}
              disabled={isMeetingHotkeyRegistering}
              maxHotkeys={isUsingNativeShortcut ? 1 : undefined}
            />
          </SettingsPanelRow>
          <SettingsPanelRow className="flex items-center justify-between gap-3 border-t border-border/70 dark:border-white/10">
            <span className="text-xs text-muted-foreground/80">
              {t("settingsPage.general.meetingHotkey.layoutLabel")}
            </span>
            <Select
              value={meetingHotkeyLayoutMode}
              onValueChange={(value) =>
                setMeetingHotkeyLayoutMode(value as "side-panel" | "full-width")
              }
            >
              <SelectTrigger
                aria-label={t("settingsPage.general.meetingHotkey.layoutLabel")}
                className="h-7 w-36 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full-width" className="text-xs py-1.5 ps-2.5 pe-7 rounded-md">
                  {t("settingsPage.general.meetingHotkey.layoutFullWidth")}
                </SelectItem>
                <SelectItem value="side-panel" className="text-xs py-1.5 ps-2.5 pe-7 rounded-md">
                  {t("settingsPage.general.meetingHotkey.layoutSidePanel")}
                </SelectItem>
              </SelectContent>
            </Select>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}

export default function HotkeysSection(props: Props) {
  return (
    <KeepAlive active={props.active}>
      <HotkeysControls {...props} />
    </KeepAlive>
  );
}
