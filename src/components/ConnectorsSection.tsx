import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "./icons";
import { Button } from "./ui/button";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsBlockedByOrg } from "../stores/policyRules";
import { getUsageState, subscribeUsage } from "../lib/usageStore";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
import type { ConnectorActionRecord } from "../types/connectors";
import { hasConnectorPlan } from "../utils/connectorEligibility";
import { normalizeDbDate } from "../utils/dateFormatting";
import {
  EMAIL_DRAFT_TARGET_SETTINGS,
  resolveEmailDraftTarget,
  type EmailDraftTargetSetting,
} from "../utils/emailDraftTarget";

function formatWhen(createdAt: string, locale: string): string {
  const date = normalizeDbDate(createdAt);
  return Number.isNaN(date.getTime())
    ? createdAt
    : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

interface ConnectorsSectionProps {
  onUpgrade: () => void;
}

export function ConnectorsSection({ onUpgrade }: ConnectorsSectionProps): ReactElement {
  const { t, i18n } = useTranslation();
  const blockedByOrg = usePolicyStore(isConnectorsBlockedByOrg);
  const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  const emailDraftTarget = useSettingsStore((state) => state.emailDraftTarget);
  const setEmailDraftTarget = useSettingsStore((state) => state.setEmailDraftTarget);
  const gcalConnected = useSettingsStore((state) => state.gcalConnected);
  const mcalAccounts = useSettingsStore((state) => state.mcalAccounts);
  // The same plan check that decides whether the chat gets the connector tools.
  const usage = useSyncExternalStore(subscribeUsage, getUsageState);
  const isSubscribedFlag = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  const isPaid = isSignedIn && hasConnectorPlan(usage, isSubscribedFlag);
  const accountId = usage.accountId;
  const [recent, setRecent] = useState<ConnectorActionRecord[]>([]);

  // Receipts are per account, so a different signed-in account refetches.
  useEffect(() => {
    setRecent([]);
    if (!isPaid || blockedByOrg) return undefined;
    let active = true;
    void window.electronAPI
      ?.connectorRecentActions?.("email", 10)
      .then((rows) => {
        if (active) setRecent(rows ?? []);
      })
      .catch(() => {
        if (active) setRecent([]);
      });
    return () => {
      active = false;
    };
  }, [isPaid, blockedByOrg, accountId]);

  const automaticTarget = resolveEmailDraftTarget({
    emailDraftTarget: "auto",
    gcalConnected,
    mcalAccounts,
  });
  const optionLabel = (option: EmailDraftTargetSetting): string =>
    option === "auto"
      ? t("connectors.email.autoResolved", {
          target: t(`connectors.email.targets.${automaticTarget}`),
        })
      : t(`connectors.email.targets.${option}`);

  const description = blockedByOrg
    ? t("connectors.policyOff")
    : isPaid
      ? t("connectors.email.description")
      : t("connectors.email.proRequired");
  const showActions = isPaid && !blockedByOrg;

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
            <Mail className="h-4 w-4 text-primary/80" strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">{t("connectors.email.title")}</p>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">{description}</p>
          </div>
          {showActions && (
            <Select
              value={emailDraftTarget}
              onValueChange={(value) => setEmailDraftTarget(value as EmailDraftTargetSetting)}
            >
              <SelectTrigger
                className="w-48 shrink-0"
                aria-label={t("connectors.email.targetLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_DRAFT_TARGET_SETTINGS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {optionLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!isPaid && !blockedByOrg && (
            <Button size="sm" className="shrink-0" onClick={onUpgrade}>
              {t("connectors.viewPlans")}
            </Button>
          )}
        </div>

        {showActions && recent.length > 0 && (
          <div className="mt-3">
            <SectionLabel>{t("connectors.recent.title")}</SectionLabel>
            <ul className="space-y-1">
              {recent.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                >
                  <span className="truncate" dir="auto">
                    {row.destinationLabel
                      ? t(`connectors.recent.actions.${row.connector}_${row.action}`, {
                          destination: row.destinationLabel,
                        })
                      : // A run interrupted by a quit never learned its destination.
                        t(`connectors.recent.unlabeledActions.${row.connector}_${row.action}`)}
                  </span>
                  <span className="shrink-0">
                    {formatWhen(row.createdAt, i18n.language)} ·{" "}
                    {t(`connectors.recent.states.${row.state}`)}
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
