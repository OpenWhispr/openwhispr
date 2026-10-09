import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { IntegrationsPane, UpsellBar } from "./IntegrationsPane";
import claudeIcon from "../../assets/icons/providers/claude.svg";
import openaiIcon from "../../assets/icons/providers/openai.svg";
import cursorIcon from "../../assets/icons/providers/cursor.svg";

const MCP_URL = "https://mcp.openwhispr.com/mcp";
const MCP_DOCS_URL = "https://docs.openwhispr.com/integrations/mcp";

const MCP_CLIENTS = [
  { name: "Claude", icon: claudeIcon },
  { name: "ChatGPT", icon: openaiIcon },
  { name: "Cursor", icon: cursorIcon },
];

interface McpPaneProps {
  title: string;
  isPaid: boolean;
  onUpgrade: () => void;
  onCreateKey: () => void;
}

export function McpPane({ title, isPaid, onUpgrade, onCreateKey }: McpPaneProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.mcp.description")}
      docsUrl={MCP_DOCS_URL}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 ps-1 text-xs">
        <span className="text-muted-foreground/80">{t("integrations.mcp.worksWith")}</span>
        {MCP_CLIENTS.map((client) => (
          <span key={client.name} className="flex items-center gap-1.5 text-foreground/85">
            <img
              src={client.icon}
              alt=""
              aria-hidden="true"
              width={14}
              height={14}
              decoding="async"
              draggable={false}
              className="h-3.5 w-3.5 icon-monochrome"
            />
            {client.name}
          </span>
        ))}
      </div>

      {!isPaid && <UpsellBar message={t("integrations.mcp.proRequired")} onUpgrade={onUpgrade} />}

      <SettingsPanel>
        <SettingsPanelRow>
          <p className="text-xs leading-5 font-medium text-foreground mb-2">
            {t("integrations.mcp.step1")}
          </p>
          <CopyableCommand
            command={MCP_URL}
            copyLabel={t("integrations.mcp.copyUrl")}
            onCopied={() =>
              toast({ title: t("integrations.mcp.copied"), variant: "success", duration: 2000 })
            }
          />
        </SettingsPanelRow>
        <SettingsPanelRow>
          <h3 className="text-xs font-semibold text-foreground">
            {t("integrations.mcp.oauthTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {t("integrations.mcp.oauthDescription")}
          </p>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1 basis-60 min-w-0">
              <h3 className="text-xs font-semibold text-foreground">
                {t("integrations.mcp.apiKeyTitle")}
              </h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {t("integrations.mcp.apiKeyDescription")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateKey}
              disabled={!isPaid}
              className="shrink-0"
            >
              {t("apiKeysSection.createButton")}
            </Button>
          </div>
          <code dir="ltr" className="block text-xs text-foreground mt-2 break-all select-all">
            Authorization: Bearer YOUR_API_KEY
          </code>
        </SettingsPanelRow>
      </SettingsPanel>
    </IntegrationsPane>
  );
}
