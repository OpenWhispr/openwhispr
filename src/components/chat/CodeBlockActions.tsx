import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "../icons";
import { Button } from "../ui/button";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";

/** Copy a code block exactly as shown. */
export function CodeBlockActions({ code }: { code: string }): ReactElement {
  const { t } = useTranslation();
  // copyText writes the code exactly; copy() would trim its indentation.
  const { copied, copyText, confirmCopied } = useCopyFeedback(code);

  const copy = async (): Promise<void> => {
    if (await copyText(code)) confirmCopied(code);
  };

  return (
    // Kept out of text selections, so selecting an answer never picks up its controls.
    <div className="mb-2 min-w-0 select-none">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
      </div>
    </div>
  );
}
