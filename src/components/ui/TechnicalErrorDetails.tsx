import { Check, Copy } from "lucide-react";
import type { TFunction } from "i18next";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { cn } from "../lib/utils";
import type { TechnicalErrorDetailsData } from "./useToast";

function formatTechnicalErrorDetails(details: TechnicalErrorDetailsData, t: TFunction): string {
  return [
    details.status !== undefined
      ? `${t("reasoning.enterprise.technicalDetails.httpStatus")}: ${details.status}`
      : "",
    details.exceptionType
      ? `${t("reasoning.enterprise.technicalDetails.awsException")}: ${details.exceptionType}`
      : "",
    details.requestId
      ? `${t("reasoning.enterprise.technicalDetails.awsRequestId")}: ${details.requestId}`
      : "",
    details.underlyingError
      ? `${t("reasoning.enterprise.technicalDetails.underlyingError")}: ${details.underlyingError}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function TechnicalErrorDetails({
  details,
  onDark = false,
}: {
  details?: TechnicalErrorDetailsData;
  onDark?: boolean;
}): JSX.Element | null {
  const { t } = useTranslation();
  const text = details ? formatTechnicalErrorDetails(details, t) : "";
  const { copied, copy } = useCopyFeedback(text, { resetMs: 2000 });
  if (!text) return null;

  return (
    <details
      className={cn(
        "group/details mt-1.5 rounded-[3px] border px-1.5 py-1 text-xs",
        onDark ? "border-white/6 bg-white/4 text-white/45" : "border-border bg-muted/50"
      )}
    >
      <summary className="cursor-pointer select-none text-xs text-muted-foreground">
        {t("reasoning.enterprise.technicalDetails.title")}
      </summary>
      <div className="mt-1.5 flex items-start justify-between gap-2">
        <pre className="min-w-0 flex-1 whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-snug select-all">
          {text}
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          className={cn(
            "shrink-0 rounded-xs p-1 transition-colors",
            onDark
              ? "text-white/30 hover:bg-white/6 hover:text-white/70"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
          aria-label={t("reasoning.enterprise.technicalDetails.copy")}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </div>
    </details>
  );
}
