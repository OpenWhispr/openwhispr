import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink } from "../icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { IntegrationsPane } from "./IntegrationsPane";

const CLI_DOCS_URL = "https://docs.openwhispr.com/cli/install";
const INSTALL_CMD = "npm install -g @openwhispr/cli";
const LOCAL_EXAMPLE = "openwhispr --local notes list";
const CLOUD_LOGIN_CMD = "openwhispr auth login";

interface CliPaneProps {
  title: string;
  isPaid: boolean;
  onUpgrade: () => void;
}

export function CliPane({ title, isPaid, onUpgrade }: CliPaneProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [docsLinkCopied, setDocsLinkCopied] = useState(false);

  const handleCopyDocsLink = async () => {
    try {
      await navigator.clipboard.writeText(CLI_DOCS_URL);
      setDocsLinkCopied(true);
      toast({
        title: t("integrations.cli.docsLinkCopied"),
        variant: "success",
        duration: 2000,
      });
      setTimeout(() => setDocsLinkCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.cli.description")}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopyDocsLink}
            className="gap-1.5 text-muted-foreground"
          >
            {docsLinkCopied ? (
              <Check className="h-3 w-3 text-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {t("integrations.cli.copyDocsLink")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.electronAPI?.openExternal?.(CLI_DOCS_URL)}
            className="gap-1.5"
          >
            {t("integrations.cli.learnMore")}
            <ExternalLink className="h-3 w-3" />
          </Button>
        </>
      }
    >
      <div>
        <SectionLabel>{t("integrations.cli.installLabel")}</SectionLabel>
        <CopyableCommand command={INSTALL_CMD} />
      </div>

      <div className="grid gap-3 @min-[56rem]:grid-cols-2">
        <SettingsPanel>
          <SettingsPanelRow className="space-y-2.5">
            <div>
              <div className="flex h-[18px] items-center gap-1.5">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("integrations.cli.local.label")}
                </h3>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                  {t("integrations.cli.local.freeBadge")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {t("integrations.cli.local.description")}
              </p>
            </div>
            <CopyableCommand command={LOCAL_EXAMPLE} />
          </SettingsPanelRow>
        </SettingsPanel>

        <SettingsPanel>
          <SettingsPanelRow className="space-y-2.5">
            <div>
              <div className="flex h-[18px] items-center gap-1.5">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("integrations.cli.cloud.label")}
                </h3>
                {!isPaid && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                    {t("integrations.plan.pro")}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
                {isPaid
                  ? t("integrations.cli.cloud.description")
                  : t("integrations.cli.cloud.proRequired")}
              </p>
            </div>
            {isPaid ? (
              <CopyableCommand command={CLOUD_LOGIN_CMD} />
            ) : (
              <Button size="sm" onClick={onUpgrade}>
                {t("integrations.cli.viewPlans")}
              </Button>
            )}
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </IntegrationsPane>
  );
}
