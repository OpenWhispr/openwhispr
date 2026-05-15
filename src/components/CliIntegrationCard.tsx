import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Terminal } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CopyableCommand } from "./ui/CopyableCommand";
import { LogoTile } from "./ui/LogoTile";
import { useToast } from "./ui/useToast";
import logo from "../assets/logo.svg";

const CLI_DOCS_URL = "https://docs.openwhispr.com/cli/install";
const INSTALL_CMD = "npm install -g @openwhispr/cli";
const LOCAL_EXAMPLE = "openwhispr --local notes list";
const CLOUD_LOGIN_CMD = "openwhispr auth login";

interface CliIntegrationCardProps {
  isPaid: boolean;
  onUpgrade: () => void;
}

export default function CliIntegrationCard({ isPaid, onUpgrade }: CliIntegrationCardProps) {
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
        category: "clipboard",
        duration: 2000,
      });
      setTimeout(() => setDocsLinkCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm p-4">
      <div className="flex items-center gap-2 mb-4">
        <LogoTile src={logo} alt="OpenWhispr" />
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
          <Terminal className="w-4 h-4 text-foreground/70" strokeWidth={2} />
        </div>
      </div>

      <h3 className="text-sm font-semibold text-foreground mb-1">{t("integrations.cli.title")}</h3>
      <p className="text-xs text-muted-foreground/70 mb-4 leading-relaxed">
        {t("integrations.cli.description")}
      </p>

      <div className="mb-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1.5">
          {t("integrations.cli.installLabel")}
        </div>
        <CopyableCommand command={INSTALL_CMD} />
      </div>

      <div className="flex items-center gap-2 mb-5">
        <Button
          size="sm"
          onClick={() => window.electronAPI?.openExternal?.(CLI_DOCS_URL)}
          className="gap-1.5"
        >
          {t("integrations.cli.learnMore")}
          <ExternalLink className="h-3 w-3" />
        </Button>
        <Button variant="outline" size="sm" onClick={handleCopyDocsLink} className="gap-1.5">
          {docsLinkCopied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {t("integrations.cli.copyDocsLink")}
        </Button>
      </div>

      <div className="mb-4">
        <div className="flex items-center gap-1.5 mb-1">
          <h4 className="text-xs font-semibold text-foreground">
            {t("integrations.cli.local.label")}
          </h4>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
            {t("integrations.cli.local.freeBadge")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground/70 mb-2 leading-relaxed">
          {t("integrations.cli.local.description")}
        </p>
        <CopyableCommand command={LOCAL_EXAMPLE} />
      </div>

      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <h4 className="text-xs font-semibold text-foreground">
            {t("integrations.cli.cloud.label")}
          </h4>
          {!isPaid && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
              {t("integrations.plan.pro")}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground/70 mb-2 leading-relaxed">
          {isPaid
            ? t("integrations.cli.cloud.description")
            : t("integrations.cli.cloud.proRequired")}
        </p>
        {isPaid ? (
          <CopyableCommand command={CLOUD_LOGIN_CMD} />
        ) : (
          <Button size="sm" onClick={onUpgrade}>
            {t("integrations.cli.viewPlans")}
          </Button>
        )}
      </div>
    </div>
  );
}
