import { useTranslation } from "react-i18next";
import type { ConfirmDialogState } from "../../hooks/useDialogs";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  effectiveHistoryRetentionDays,
  effectiveLocalHistoryEnabled,
  lockedLocalHistoryValue,
} from "../../stores/policyRules";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { RETENTION_DAY_OPTIONS, RETENTION_SELECT_CLASS } from "./retentionOptions";

type Confirmation = Pick<ConfirmDialogState, "title" | "description" | "confirmText">;

interface RetentionRow {
  kind: "chats" | "meetingTranscripts";
  label: string;
  description: string;
  storedDays: number;
  apply: (days: number) => void;
  confirmation: (count: number, days: number) => Confirmation;
}

interface HistoryRetentionRowsProps {
  showConfirmDialog: (options: Omit<ConfirmDialogState, "open">) => void;
}

// A shorter period first asks the main process how much it would remove now and
// confirms that by count; a longer one, or Forever, applies at once.
export function HistoryRetentionRows({ showConfirmDialog }: HistoryRetentionRowsProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const managed = lockedLocalHistoryValue(policy) === true;
  const chatRetentionDays = useSettingsStore((s) => s.chatRetentionDays);
  const setChatRetentionDays = useSettingsStore((s) => s.setChatRetentionDays);
  const meetingTranscriptRetentionDays = useSettingsStore((s) => s.meetingTranscriptRetentionDays);
  const setMeetingTranscriptRetentionDays = useSettingsStore(
    (s) => s.setMeetingTranscriptRetentionDays
  );

  const period = (days: number) => t("settingsPage.privacy.retentionDays", { count: days });

  const renderRow = ({
    kind,
    label,
    description,
    storedDays,
    apply,
    confirmation,
  }: RetentionRow) => {
    const days = effectiveHistoryRetentionDays(policy, storedDays);
    const choose = async (next: number) => {
      if (next === 0 || (days !== 0 && next > days)) return apply(next);
      const { count } = await window.electronAPI.retentionPreview(kind, next);
      if (count === 0) return apply(next);
      showConfirmDialog({
        ...confirmation(count, next),
        variant: "destructive",
        onConfirm: () => apply(next),
      });
    };
    return (
      <SettingsPanelRow>
        <SettingsRow label={label} description={managed ? t("common.managedByOrg") : description}>
          <select
            aria-label={label}
            value={days}
            disabled={managed}
            // A failed count leaves the period as it was.
            onChange={(e) => void choose(parseInt(e.target.value, 10)).catch(() => {})}
            className={RETENTION_SELECT_CLASS}
          >
            <option value={0}>{t("settingsPage.privacy.transcriptRetentionForever")}</option>
            {RETENTION_DAY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {period(option)}
              </option>
            ))}
          </select>
        </SettingsRow>
      </SettingsPanelRow>
    );
  };

  return (
    <>
      {renderRow({
        kind: "chats",
        label: t("settingsPage.privacy.chatRetention"),
        description: t("settingsPage.privacy.chatRetentionDescription"),
        storedDays: chatRetentionDays,
        apply: setChatRetentionDays,
        confirmation: (count, days) => ({
          title: t("settingsPage.privacy.chatRetentionConfirmTitle"),
          description: t("settingsPage.privacy.chatRetentionConfirmDescription", {
            count,
            period: period(days),
          }),
          confirmText: t("settingsPage.privacy.chatRetentionConfirmAction"),
        }),
      })}
      {renderRow({
        kind: "meetingTranscripts",
        label: t("settingsPage.privacy.meetingTranscriptRetention"),
        description: t("settingsPage.privacy.meetingTranscriptRetentionDescription"),
        storedDays: meetingTranscriptRetentionDays,
        apply: setMeetingTranscriptRetentionDays,
        confirmation: (count, days) => ({
          title: t("settingsPage.privacy.meetingTranscriptRetentionConfirmTitle"),
          description: t("settingsPage.privacy.meetingTranscriptRetentionConfirmDescription", {
            count,
            period: period(days),
          }),
          confirmText: t("settingsPage.privacy.meetingTranscriptRetentionConfirmAction"),
        }),
      })}
    </>
  );
}

export function TranscriptRetentionRow() {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const managed = lockedLocalHistoryValue(policy) === true;
  const dataRetentionEnabled = useSettingsStore((s) => s.dataRetentionEnabled);
  const transcriptRetentionDays = useSettingsStore((s) => s.transcriptRetentionDays);
  const setTranscriptRetentionDays = useSettingsStore((s) => s.setTranscriptRetentionDays);
  const label = t("settingsPage.privacy.transcriptRetention");

  return (
    <SettingsPanelRow>
      <SettingsRow
        label={label}
        description={
          managed
            ? t("common.managedByOrg")
            : t("settingsPage.privacy.transcriptRetentionDescription")
        }
      >
        <select
          aria-label={label}
          value={effectiveHistoryRetentionDays(policy, transcriptRetentionDays)}
          disabled={managed || !effectiveLocalHistoryEnabled(policy, dataRetentionEnabled)}
          onChange={(e) => setTranscriptRetentionDays(parseInt(e.target.value, 10))}
          className={RETENTION_SELECT_CLASS}
        >
          <option value={0}>{t("settingsPage.privacy.transcriptRetentionForever")}</option>
          {RETENTION_DAY_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {t("settingsPage.privacy.retentionDays", { count: days })}
            </option>
          ))}
        </select>
      </SettingsRow>
    </SettingsPanelRow>
  );
}
