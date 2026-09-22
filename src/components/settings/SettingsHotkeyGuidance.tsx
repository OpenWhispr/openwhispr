import { useTranslation } from "react-i18next";
import type { HotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { formatList } from "../../lib/formatList";
import type { Platform } from "../../utils/platform";
import { MicVocal, Zap } from "../icons";
import { HotkeyGestureChip, HotkeyGestureRowsContent } from "../ui/HotkeyGestureRows";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";

export interface SettingsHotkeySlot {
  name: "dictation" | "voiceAgent" | "translation";
  hotkey: string;
  mode: "push" | "tap";
  info: HotkeyModeInfo;
  pending: boolean;
}

function canHold({ hotkey, mode, info, pending }: SettingsHotkeySlot) {
  return !pending && info.loaded && info.supportsPushToTalk && (!hotkey || mode === "push");
}

function needsLinuxSetup(slot: SettingsHotkeySlot, platform: Platform) {
  return (
    platform === "linux" && !slot.info.isUsingNativeShortcut && slot.info.linuxPttPermissionDenied
  );
}

export function SettingsHotkeyGestureGuide({
  slots,
  platform,
}: {
  slots: SettingsHotkeySlot[];
  platform: Platform;
}) {
  const { t, i18n } = useTranslation();
  const supported = slots.filter((slot) => canHold(slot) && !needsLinuxSetup(slot, platform));
  if (!supported.some(({ hotkey }) => hotkey)) return null;

  const language = i18n.resolvedLanguage || i18n.language;
  const shortcuts = formatList(
    language === "en" ? "en-GB" : language,
    supported.map(({ name }) => t(`settingsPage.general.hotkey.guide.${name}`))
  );

  return (
    <SettingsPanel className="@container">
      <SettingsPanelRow>
        <aside aria-label={t("settingsPage.general.hotkey.guide.title")}>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.general.hotkey.guide.title")}
          </h3>
          <p className="mt-0.5 mb-3 text-[11px] leading-relaxed text-muted-foreground">
            {t("settingsPage.general.hotkey.guide.scope", { shortcuts })}
          </p>
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @sm:gap-4">
            <div>
              <HotkeyGestureChip
                icon={<MicVocal className="size-3" aria-hidden="true" />}
                label={t("common.hold")}
                accent
              />
              <p className="mt-1.5 text-xs font-medium text-foreground">
                {t("settingsPage.general.hotkey.gestures.holdTitle")}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("settingsPage.general.hotkey.gestures.holdDetail")}
              </p>
            </div>
            <div className="border-t border-border/50 pt-3 @sm:border-t-0 @sm:border-s @sm:pt-0 @sm:ps-4">
              <HotkeyGestureChip
                icon={<Zap className="size-3" aria-hidden="true" />}
                label={t("settingsPage.general.hotkey.gestures.doublePress")}
              />
              <p className="mt-1.5 text-xs font-medium text-foreground">
                {t("settingsPage.general.hotkey.guide.handsFreeStart")}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("settingsPage.general.hotkey.gestures.handsFreeDetail")}
              </p>
            </div>
          </div>
        </aside>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}

export function SettingsHotkeyException({
  slot,
  platform,
}: {
  slot: SettingsHotkeySlot;
  platform: Platform;
}) {
  if (!slot.hotkey || slot.pending || !slot.info.loaded) return null;

  const showLinuxSetup = needsLinuxSetup(slot, platform);
  if (canHold(slot) && !showLinuxSetup) return null;

  return (
    <SettingsPanelRow>
      <HotkeyGestureRowsContent
        hotkey={slot.hotkey}
        mode="tap"
        pushToTalkUnavailableReason={slot.info.pushToTalkUnavailableReason}
      />
      {slot.name === "dictation" && showLinuxSetup && <LinuxPttSetupInfo isAvailable={false} />}
    </SettingsPanelRow>
  );
}
