import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "./icons";
import { SettingsPanel, SettingsPanelRow } from "./ui/SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ConnectorLoginRow } from "./connectors/ConnectorLoginRow";
import { CONNECTOR_ROWS } from "./connectors/connectorRows";
import { useSettingsStore } from "../stores/settingsStore";
import { useConnectorStatusStore } from "../stores/connectorStatusStore";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";
import {
  EMAIL_DRAFT_TARGET_SETTINGS,
  gmailSendStatus,
  resolveEmailDraftTarget,
  type EmailDraftTargetSetting,
} from "../utils/emailDraftTarget";

export function ConnectorsSection(): ReactElement {
  const { t } = useTranslation();
  const blockedByOrg = usePolicyStore(isConnectorsBlockedByOrg);
  const connectorsAllowed = usePolicyStore(isConnectorsAllowed);
  const emailDraftTarget = useSettingsStore((state) => state.emailDraftTarget);
  const setEmailDraftTarget = useSettingsStore((state) => state.setEmailDraftTarget);
  const gcalConnected = useSettingsStore((state) => state.gcalConnected);
  const mcalAccounts = useSettingsStore((state) => state.mcalAccounts);
  const gmail = useConnectorStatusStore((state) => state.statuses.gmail);
  const gmailStatus = gmailSendStatus(gmail);

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
    if (option === "gmailSend" && gmailSendUnavailable) {
      return t("connectors.email.targets.gmailSendConnectFirst");
    }
    return t(`connectors.email.targets.${option}`);
  };

  const description = blockedByOrg
    ? t("connectors.policyOff")
    : !connectorsAllowed
      ? t("connectors.email.unavailable")
      : currentTarget === "gmailSend"
        ? t("connectors.email.descriptionSend")
        : t("connectors.email.description");

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/5 dark:bg-primary/10 flex items-center justify-center shrink-0">
            <Mail className="h-4 w-4 text-primary/80" strokeWidth={2} aria-hidden="true" />
          </div>
          <div className="flex-1 basis-52 min-w-0">
            <p className="text-xs font-semibold text-foreground">{t("connectors.email.title")}</p>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">{description}</p>
            {connectorsAllowed && (shownTarget === "auto" || shownTarget === "mailto") && (
              <p className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">
                {shownTarget === "auto"
                  ? t("connectors.email.automaticHint", {
                      target: t(`connectors.email.targets.${currentTarget}`),
                    })
                  : t("connectors.email.systemMailHint")}
              </p>
            )}
          </div>
          {connectorsAllowed && (
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
        </div>
      </SettingsPanelRow>
      {CONNECTOR_ROWS.map((row) => (
        <ConnectorLoginRow key={row.id} row={row} blockedByOrg={blockedByOrg} />
      ))}
    </SettingsPanel>
  );
}
