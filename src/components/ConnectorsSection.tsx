import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "./icons";
import { Button } from "./ui/button";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed } from "../stores/policyRules";
import type { ConnectorActionRecord } from "../types/connectors";

const EMAIL_TARGET_OPTIONS = ["auto", "gmail", "outlookWork", "outlookPersonal", "mailto"] as const;

function formatWhen(createdAt: string): string {
  // SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS".
  const date = new Date(`${createdAt.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime())
    ? createdAt
    : date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

interface ConnectorsSectionProps {
  isPaid: boolean;
  onUpgrade: () => void;
}

export function ConnectorsSection({ isPaid, onUpgrade }: ConnectorsSectionProps): ReactElement {
  const { t } = useTranslation();
  const allowed = usePolicyStore((state) => isConnectorsAllowed(state));
  const emailDraftTarget = useSettingsStore((state) => state.emailDraftTarget);
  const setEmailDraftTarget = useSettingsStore((state) => state.setEmailDraftTarget);
  const [recent, setRecent] = useState<ConnectorActionRecord[]>([]);

  useEffect(() => {
    if (!isPaid || !allowed) return undefined;
    let active = true;
    void window.electronAPI
      ?.connectorRecentActions?.("email", 10)
      .then((rows) => {
        if (active) setRecent(rows ?? []);
      });
    return () => {
      active = false;
    };
  }, [isPaid, allowed]);

  if (!allowed) {
    return (
      <SettingsPanel>
        <SettingsPanelRow>
          <p className="text-xs text-muted-foreground/70">{t("connectors.policyOff")}</p>
        </SettingsPanelRow>
      </SettingsPanel>
    );
  }

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
            <Mail className="w-4 h-4 text-primary" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">{t("connectors.email.title")}</p>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
              {t("connectors.email.description")}
            </p>
          </div>
          {isPaid ? (
            <Select value={emailDraftTarget} onValueChange={setEmailDraftTarget}>
              <SelectTrigger className="w-48 shrink-0" aria-label={t("connectors.email.targetLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_TARGET_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`connectors.email.targets.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button size="sm" className="shrink-0" onClick={onUpgrade}>
              {t("connectors.upgrade")}
            </Button>
          )}
        </div>

        {isPaid && recent.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {t("connectors.recent.title")}
            </p>
            <ul className="space-y-1">
              {recent.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate" dir="auto">
                    {t(`connectors.recent.actions.${row.connector}_${row.action}`, {
                      destination: row.destinationLabel ?? "",
                    })}
                  </span>
                  <span className="shrink-0">
                    {formatWhen(row.createdAt)} · {t(`connectors.recent.states.${row.state}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
