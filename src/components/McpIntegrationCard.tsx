import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Plus } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { LogoTile } from "./ui/LogoTile";
import { useToast } from "./ui/useToast";
import logo from "../assets/logo.svg";
import claudeIcon from "../assets/icons/providers/claude.svg";
import openaiIcon from "../assets/icons/providers/openai.svg";
import cursorIcon from "../assets/icons/providers/cursor.svg";

const MCP_URL = "https://mcp.openwhispr.com/mcp";
const MCP_DOCS_URL = "https://docs.openwhispr.com/integrations/mcp";

interface McpIntegrationCardProps {
  isPaid: boolean;
  onUpgrade: () => void;
}

export default function McpIntegrationCard({ isPaid, onUpgrade }: McpIntegrationCardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      toast({ title: t("integrations.mcp.copied"), variant: "success", category: "clipboard", duration: 2000 });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <LogoTile src={logo} alt="OpenWhispr" />
        <Plus className="h-3 w-3 text-muted-foreground/40 shrink-0" />
        <div className="flex items-center gap-1">
          <LogoTile src={claudeIcon} alt="Claude" monochrome />
          <LogoTile src={openaiIcon} alt="ChatGPT" monochrome />
          <LogoTile src={cursorIcon} alt="Cursor" monochrome />
        </div>
      </div>

      <div className="flex items-center gap-1.5 mb-1">
        <h3 className="text-sm font-semibold text-foreground">{t("integrations.mcp.title")}</h3>
        {!isPaid && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
            {t("integrations.plan.pro")}
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground/70 mb-4 leading-relaxed">
        {isPaid ? t("integrations.mcp.description") : t("integrations.mcp.proRequired")}
      </p>

      {isPaid && (
        <ol className="space-y-1.5 text-xs text-muted-foreground mb-4 list-decimal pl-4 marker:text-muted-foreground/40">
          <li className="leading-relaxed">
            {t("integrations.mcp.step1")}{" "}
            <span className="inline-flex items-center gap-1 rounded-md border border-primary/15 bg-primary/5 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground align-middle">
              {MCP_URL}
              <button
                type="button"
                onClick={handleCopy}
                aria-label={t("integrations.mcp.copyUrl")}
                className="p-0.5 rounded transition-colors hover:bg-primary/10 text-muted-foreground hover:text-foreground"
              >
                {copied ? (
                  <Check className="h-2.5 w-2.5 text-success" />
                ) : (
                  <Copy className="h-2.5 w-2.5" />
                )}
              </button>
            </span>
          </li>
          <li className="leading-relaxed">{t("integrations.mcp.step2")}</li>
          <li className="leading-relaxed">{t("integrations.mcp.step3")}</li>
        </ol>
      )}

      {isPaid ? (
        <Button
          size="sm"
          onClick={() => window.electronAPI?.openExternal?.(MCP_DOCS_URL)}
          className="gap-1.5"
        >
          {t("integrations.mcp.learnMore")}
          <ExternalLink className="h-3 w-3" />
        </Button>
      ) : (
        <Button size="sm" onClick={onUpgrade}>
          {t("integrations.mcp.viewPlans")}
        </Button>
      )}
    </div>
  );
}
