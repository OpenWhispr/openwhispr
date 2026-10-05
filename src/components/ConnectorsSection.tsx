import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Mail } from "./icons";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { RecentActions } from "./connectors/RecentActions";
import { ConnectorLoginRow } from "./connectors/ConnectorLoginRow";
import { BetaBadge } from "./connectors/BetaBadge";
import { CONNECTOR_ROWS } from "./connectors/connectorRows";
import { UpsellBar } from "./integrations/IntegrationsPane";
import { useSettingsStore } from "../stores/settingsStore";
import { useConnectorStatusStore } from "../stores/connectorStatusStore";
import { useConnectorAccess } from "../hooks/useConnectorAccess";
import {
  EMAIL_DRAFT_TARGET_SETTINGS,
  gmailSendStatus,
  resolveEmailDraftTarget,
  type EmailDraftTargetSetting,
} from "../utils/emailDraftTarget";

interface ConnectorsSectionProps {
  onUpgrade: () => void;
}

export function ConnectorsSection({ onUpgrade }: ConnectorsSectionProps): ReactElement {
  const { t } = useTranslation();
  const { isPaid, blockedByOrg, connectorsAllowed } = useConnectorAccess();
  const emailDraftTarget = useSettingsStore((state) => state.emailDraftTarget);
  const setEmailDraftTarget = useSettingsStore((state) => state.setEmailDraftTarget);
  const gcalConnected = useSettingsStore((state) => state.gcalConnected);
  const mcalAccounts = useSettingsStore((state) => state.mcalAccounts);
  const gmail = useConnectorStatusStore((state) => state.statuses.gmail);
  const gmailStatus = gmailSendStatus(gmail);
  const showActions = isPaid && connectorsAllowed;

  const automaticTarget = resolveEmailDraftTarget({
    emailDraftTarget: "auto",
    gcalConnected,
    mcalAccounts,
    gmailStatus,
  });
  // Sending from chat needs a working Gmail login; a build without a Google
  // client never offers it.
  const targetOptions = EMAIL_DRAFT_TARGET_SETTINGS.filter(
    (option) => option !== "gmailSend" || gmail?.configured !== false
  );
  const currentTarget = resolveEmailDraftTarget({
    emailDraftTarget,
    gcalConnected,
    mcalAccounts,
    gmailStatus,
  });
  // Automatic and Send from chat both pick Gmail whenever it's connected, so
  // a saved Send from chat whose Gmail login is gone drafts, and shows, as
  // Automatic.
  const shownTarget =
    emailDraftTarget === "gmailSend" && currentTarget !== "gmailSend" ? "auto" : emailDraftTarget;
  // Send from chat needs a connected Gmail; until then it says where to connect.
  const gmailSendUnavailable = gmailStatus !== "connected";
  const optionLabel = (option: EmailDraftTargetSetting): string => {
    if (option === "auto") {
      return t("connectors.email.autoResolved", {
        target: t(`connectors.email.targets.${automaticTarget}`),
      });
    }
    if (option === "gmailSend" && gmailSendUnavailable) {
      return t("connectors.email.targets.gmailSendConnectFirst");
    }
    return t(`connectors.email.targets.${option}`);
  };

  // A free plan sees what drafting does, dimmed; the one upsell sits above the list.
  const locked = !isPaid && !blockedByOrg;
  const description = blockedByOrg
    ? t("connectors.policyOff")
    : isPaid && !connectorsAllowed
      ? t("connectors.email.unavailable")
      : isPaid && currentTarget === "gmailSend"
        ? t("connectors.email.descriptionSend")
        : t("connectors.email.description");

  return (
    <div className="space-y-3">
      {locked && <UpsellBar message={t("connectors.upsell")} onUpgrade={onUpgrade} />}
      <SettingsPanel>
        <SettingsPanelRow>
          <div className={`flex items-center gap-3 ${locked ? "opacity-60" : ""}`}>
            <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
              <Mail className="h-4 w-4 text-primary/80" strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-semibold text-foreground">
                  {t("connectors.email.title")}
                </p>
                <BetaBadge />
              </div>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {description}
              </p>
            </div>
            {showActions && (
              <Select
                value={shownTarget}
                onValueChange={(value) => setEmailDraftTarget(value as EmailDraftTargetSetting)}
              >
                <SelectTrigger
                  className="h-7 w-48 shrink-0 text-xs rounded-lg px-2.5 [&>svg]:h-3 [&>svg]:w-3"
                  aria-label={t("connectors.email.targetLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targetOptions.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      disabled={option === "gmailSend" && gmailSendUnavailable}
                    >
                      {optionLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {locked && (
              <Lock
                size={14}
                role="img"
                aria-label={t("connectors.locked")}
                className="shrink-0 text-muted-foreground"
              />
            )}
          </div>

          {showActions && <RecentActions connectorId="email" />}
        </SettingsPanelRow>
        {CONNECTOR_ROWS.map((row) => (
          <ConnectorLoginRow key={row.id} row={row} isPaid={isPaid} blockedByOrg={blockedByOrg} />
        ))}
      </SettingsPanel>
    </div>
  );
}
