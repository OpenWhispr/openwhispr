import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "../icons";
import { Button } from "../ui/button";

interface IntegrationsPaneProps {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** One Integrations section: a header with its actions, then the section's content. */
export function IntegrationsPane({
  title,
  description,
  actions,
  children,
}: IntegrationsPaneProps): ReactElement {
  return (
    <div className="space-y-4">
      {/* The actions wrap under the title when both don't fit, as with long translations. */}
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex-1 basis-60 min-w-0">
          {/* Focusable so a link that opens another section can move focus here. */}
          <h2 tabIndex={-1} className="text-base text-foreground outline-none">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">{description}</p>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

interface UpsellBarProps {
  message: string;
  onUpgrade: () => void;
}

/** Shown under a section's header when the user's plan doesn't include it. */
export function UpsellBar({ message, onUpgrade }: UpsellBarProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/20 dark:border-primary/30 bg-primary/5 dark:bg-primary/10 ps-3.5 pe-2 py-2">
      <Sparkles size={15} className="shrink-0 text-primary" />
      <p className="flex-1 min-w-0 text-xs text-foreground/85 leading-relaxed">{message}</p>
      <Button size="sm" onClick={onUpgrade} className="shrink-0">
        {t("integrations.api.viewPlans")}
      </Button>
    </div>
  );
}
