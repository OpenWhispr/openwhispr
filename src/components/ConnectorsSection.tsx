import { useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "./icons";
import { Button } from "./ui/button";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { RecentActions } from "./connectors/RecentActions";
import { SlackConnectorRow } from "./connectors/SlackConnectorRow";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";
import { getUsageState, subscribeUsage } from "../lib/usageStore";
import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
import { hasConnectorPlan } from "../utils/connectorEligibility";
import {
  EMAIL_DRAFT_TARGET_SETTINGS,
  resolveEmailDraftTarget,
  type EmailDraftTargetSetting,
} from "../utils/emailDraftTarget";

interface ConnectorsSectionProps {
  onUpgrade: () => void;
}

export function ConnectorsSection({ onUpgrade }: ConnectorsSectionProps): ReactElement {
  const { t } = useTranslation();
  const blockedByOrg = usePolicyStore(isConnectorsBlockedByOrg);
  // False while the policy loads, after a failed fetch, or when the org requires
  // a newer app: chat has no connector tools then, so the card mustn't offer them.
  const connectorsAllowed = usePolicyStore(isConnectorsAllowed);
  const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  const emailDraftTarget = useSettingsStore((state) => state.emailDraftTarget);
  const setEmailDraftTarget = useSettingsStore((state) => state.setEmailDraftTarget);
  const gcalConnected = useSettingsStore((state) => state.gcalConnected);
  const mcalAccounts = useSettingsStore((state) => state.mcalAccounts);
  // The same plan check that decides whether the chat gets the connector tools.
  const usage = useSyncExternalStore(subscribeUsage, getUsageState);
  const isSubscribedFlag = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  const isPaid = isSignedIn && hasConnectorPlan(usage, isSubscribedFlag);
  const showActions = isPaid && connectorsAllowed;

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
    : !isPaid
      ? t("connectors.email.proRequired")
      : connectorsAllowed
        ? t("connectors.email.description")
        : t("connectors.email.unavailable");

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
                className="h-7 w-48 shrink-0 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3"
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
              {t("integrations.api.viewPlans")}
            </Button>
          )}
        </div>

        {showActions && <RecentActions connectorId="email" />}
      </SettingsPanelRow>
      <SlackConnectorRow isPaid={isPaid} blockedByOrg={blockedByOrg} onUpgrade={onUpgrade} />
    </SettingsPanel>
  );
}
