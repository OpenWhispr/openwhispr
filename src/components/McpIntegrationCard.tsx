import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { useToast } from "./ui/useToast";
import { cn } from "./lib/utils";
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

function LogoTile({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
      <img src={src} alt={alt} className="w-5 h-5" />
    </div>
  );
}

export default function McpIntegrationCard({ isPaid, onUpgrade }: McpIntegrationCardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!isPaid) return;
    try {
      await navigator.clipboard.writeText(MCP_URL);
      setCopied(true);
      toast({ title: t("integrations.mcp.copied"), variant: "success", duration: 2000 });
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
          <LogoTile src={claudeIcon} alt="Claude" />
          <LogoTile src={openaiIcon} alt="ChatGPT" />
          <LogoTile src={cursorIcon} alt="Cursor" />
        </div>
      </div>

      <h3 className="text-sm font-semibold text-foreground mb-1">{t("integrations.mcp.title")}</h3>
      <p className="text-xs text-muted-foreground/70 mb-4 leading-relaxed">
        {t("integrations.mcp.description")}
      </p>

      <ol className="space-y-1.5 text-xs text-muted-foreground mb-4 list-decimal pl-4 marker:text-muted-foreground/40">
        <li className="leading-relaxed">
          {t("integrations.mcp.step1")}{" "}
          <span className="inline-flex items-center gap-1 rounded-md border border-primary/15 bg-primary/5 px-1.5 py-0.5 font-mono text-[10.5px] text-foreground align-middle">
            {MCP_URL}
            <button
              type="button"
              disabled={!isPaid}
              onClick={handleCopy}
              aria-label={t("integrations.mcp.copyUrl")}
              className={cn(
                "p-0.5 rounded transition-colors",
                isPaid
                  ? "hover:bg-primary/10 text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/40 cursor-not-allowed"
              )}
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
