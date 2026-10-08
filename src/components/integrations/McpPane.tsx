import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "../icons";
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

interface StepProps {
  number: number;
  /** Centre the number on a single-line step that sits beside a button. */
  centered?: boolean;
  children: ReactNode;
}

function Step({ number, centered = false, children }: StepProps): ReactElement {
  return (
    <SettingsPanelRow as="li">
      <div className={`flex gap-3 ${centered ? "items-center" : "items-start"}`}>
        {/* The list already gives each step its position. */}
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
        >
          {number}
        </span>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </SettingsPanelRow>
  );
}

export function McpPane({ title, isPaid, onUpgrade, onCreateKey }: McpPaneProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.mcp.description")}
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => window.electronAPI?.openExternal?.(MCP_DOCS_URL)}
          className="gap-1.5 text-muted-foreground"
        >
          {t("integrations.mcp.learnMore")}
          <ExternalLink className="h-3 w-3" />
        </Button>
      }
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

      <SettingsPanel as="ol">
        <Step number={1}>
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
        </Step>
        <Step number={2} centered>
          <div className="flex items-center gap-3">
            <p className="flex-1 min-w-0 text-xs font-medium text-foreground">
              {t("integrations.mcp.step2")}
            </p>
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
        </Step>
        <Step number={3} centered>
          <p className="text-xs font-medium text-foreground">{t("integrations.mcp.step3")}</p>
        </Step>
      </SettingsPanel>
    </IntegrationsPane>
  );
}
