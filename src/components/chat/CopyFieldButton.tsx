import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, CopyRounded } from "../icons";
import { cn } from "../lib/utils";
import { ICON_BUTTON } from "./interactions/cardStyles";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";

/**
 * Copies one field of an answer card (its recipients, its subject, its body),
 * shown while the pointer or the keyboard is on that field, with a check once
 * copied. The field's row is the `group` it shows for.
 */
export function CopyFieldButton({ text, label }: { text: string; label: string }): ReactElement {
  const { t } = useTranslation();
  const { copied, copyText, confirmCopied } = useCopyFeedback(text);
  return (
    <button
      type="button"
      onClick={() => void copyText(text).then((done) => done && confirmCopied(text))}
      aria-label={copied ? t("common.copied") : label}
      title={copied ? t("common.copied") : label}
      className={cn(
        ICON_BUTTON,
        "size-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
        copied && "opacity-100"
      )}
    >
      {copied ? <Check size={13} className="text-success" /> : <CopyRounded size={13} />}
    </button>
  );
}
