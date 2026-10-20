import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { Progress } from "./ui/progress";
import { HotkeyListInput } from "./ui/HotkeyListInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SettingsPanel, SettingsPanelRow, SectionHeader, SettingsRow } from "./ui/SettingsSection";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { formatBytes } from "../utils/formatBytes";
import { useSettingsStore } from "../stores/settingsStore";
import type { ReadAloudConfig, ReadAloudStatus } from "../types/electron";

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

type InstallProgress = { voiceId: string; phase: "downloading" | "installing"; percentage: number };

export default function ReadAloudSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReadAloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const dictationKey = useSettingsStore((s) => s.dictationKey);
  const meetingKey = useSettingsStore((s) => s.meetingKey);
  const voiceAgentKey = useSettingsStore((s) => s.voiceAgentKey);
  const translationKey = useSettingsStore((s) => s.translationKey);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.readAloudGetStatus?.().then((s) => {
      if (!cancelled && s) setStatus(s);
    });
    const unsubscribe = window.electronAPI?.onReadAloudInstallProgress?.((p) => setProgress(p));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const update = useCallback(
    async (patch: Partial<ReadAloudConfig>) => {
      const result = await window.electronAPI?.readAloudSetConfig?.(patch);
      if (!result) return false;
      setStatus(result.status);
      setError(result.success ? null : result.error || t("settingsPage.readAloud.errors.generic"));
      return result.success;
    },
    [t]
  );

  const install = useCallback(
    async (voiceId: string) => {
      setError(null);
      setProgress({ voiceId, phase: "downloading", percentage: 0 });
      const result = await window.electronAPI?.readAloudInstallVoice?.(voiceId);
      setProgress(null);
      if (!result) return;
      setStatus(result.status);
      if (!result.success) setError(t("settingsPage.readAloud.errors.download"));
    },
    [t]
  );

  const remove = useCallback(async (voiceId: string) => {
    const result = await window.electronAPI?.readAloudRemoveVoice?.(voiceId);
    if (result) setStatus(result.status);
  }, []);

  const validate = useCallback(
    (hotkey: string, other: string) =>
      validateHotkeyForSlot(
        hotkey,
        {
          "settingsPage.general.hotkey.title": dictationKey,
          "settingsPage.general.meetingHotkey.title": meetingKey,
          "settingsPage.general.voiceAgentHotkey.title": voiceAgentKey,
          "settingsPage.general.translationHotkey.title": translationKey,
          "settingsPage.readAloud.otherHotkey": other,
        },
        t
      ),
    [dictationKey, meetingKey, voiceAgentKey, translationKey, t]
  );

  if (!status) return null;

  const voice = status.voices.find((v) => v.id === status.voice) ?? status.voices[0];
  const busy = status.installing !== null || progress !== null;

  return (
    <div>
      <SectionHeader
        title={t("settingsPage.readAloud.title")}
        description={t("settingsPage.readAloud.description")}
      />
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.readAloud.enable")}
            description={t("settingsPage.readAloud.enableDescription")}
          >
            <Toggle checked={status.enabled} onChange={(enabled) => update({ enabled })} />
          </SettingsRow>
        </SettingsPanelRow>

        {status.enabled && (
          <>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.readAloud.voice")}
                description={
                  voice.installed
                    ? t("settingsPage.readAloud.voiceInstalled")
                    : t("settingsPage.readAloud.voiceMissing", {
                        size: formatBytes(voice.sizeBytes),
                      })
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={status.voice}
                    onValueChange={(value) => update({ voice: value })}
                    disabled={busy}
                  >
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {status.voices.map((v) => (
                        <SelectItem key={v.id} value={v.id} className="text-xs">
                          {v.label}
                          {v.installed ? " ✓" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {voice.installed ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.electronAPI?.readAloudTest?.()}
                      >
                        {t("settingsPage.readAloud.test")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove(voice.id)}
                      >
                        {t("settingsPage.readAloud.remove")}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => install(voice.id)}>
                      {t("settingsPage.readAloud.download")}
                    </Button>
                  )}
                </div>
              </SettingsRow>
              {progress && (
                <div className="mt-3 space-y-1">
                  <Progress value={progress.percentage} className="h-1.5" />
                  <p className="text-xs text-muted-foreground/80">
                    {progress.phase === "installing"
                      ? t("settingsPage.readAloud.installing")
                      : t("settingsPage.readAloud.downloading", { percent: progress.percentage })}
                  </p>
                </div>
              )}
            </SettingsPanelRow>

            <SettingsPanelRow>
              <SettingsRow label={t("settingsPage.readAloud.speed")}>
                <Select
                  value={String(status.speed)}
                  onValueChange={(value) => update({ speed: Number(value) })}
                >
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPEEDS.map((speed) => (
                      <SelectItem key={speed} value={String(speed)} className="text-xs">
                        {`${speed}×`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            </SettingsPanelRow>

            <SettingsPanelRow>
              <p className="text-xs font-medium text-foreground mb-2">
                {t("settingsPage.readAloud.readHotkey")}
              </p>
              <HotkeyListInput
                value={status.readKey}
                maxHotkeys={1}
                onChange={(list) => update({ readKey: list })}
                onClear={() => update({ readKey: "" })}
                validate={(hotkey) => validate(hotkey, status.pauseKey)}
              />
            </SettingsPanelRow>

            <SettingsPanelRow>
              <p className="text-xs font-medium text-foreground mb-2">
                {t("settingsPage.readAloud.pauseHotkey")}
              </p>
              <HotkeyListInput
                value={status.pauseKey}
                maxHotkeys={1}
                onChange={(list) => update({ pauseKey: list })}
                onClear={() => update({ pauseKey: "" })}
                validate={(hotkey) => validate(hotkey, status.readKey)}
              />
            </SettingsPanelRow>

            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.readAloud.indicator")}
                description={t("settingsPage.readAloud.indicatorDescription")}
              >
                <Toggle
                  checked={status.showIndicator}
                  onChange={(showIndicator) => update({ showIndicator })}
                />
              </SettingsRow>
            </SettingsPanelRow>
          </>
        )}
      </SettingsPanel>
      {error && <p className="text-xs text-destructive mt-2">{error}</p>}
      {status.enabled && (
        <p className="text-xs text-muted-foreground/80 mt-2">
          {t("settingsPage.readAloud.privacy")}
        </p>
      )}
    </div>
  );
}
