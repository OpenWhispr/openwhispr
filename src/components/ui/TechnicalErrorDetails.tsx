import { Check, Copy } from "../icons";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { formatProviderErrorDetails } from "../../utils/describeProviderError";
import type { TechnicalErrorDetailsData } from "./useToast";

export function TechnicalErrorDetails({
  details,
}: {
  details?: TechnicalErrorDetailsData;
}): JSX.Element | null {
  const { t } = useTranslation();
  const text = details ? formatProviderErrorDetails(details, t) : "";
  const { copied, copy } = useCopyFeedback(text, { resetMs: 2000 });
  if (!text) return null;

  return (
    <details className="group/details mt-1.5 rounded-[3px] border border-border bg-muted/50 px-1.5 py-1 text-xs">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        {t("reasoning.enterprise.technicalDetails.title")}
      </summary>
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <pre
          dir="ltr"
          className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-snug select-all"
        >
          {text}
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded-xs p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("reasoning.enterprise.technicalDetails.copy")}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
    </details>
  );
}
