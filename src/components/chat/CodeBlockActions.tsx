import { useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Terminal } from "../icons";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";

// What a paste must not carry: line breaks of any kind, which a terminal without bracketed
// paste runs as they land, other control characters (Tab completes, Ctrl-O runs the line, ESC
// starts a sequence), and invisible or direction-changing ones that make what is shown differ
// from what is pasted.
const UNPASTEABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Copy for a code block in an answer, and Paste into app where a paste target exists. Paste is
 * for one plain line only; anything else keeps Copy, so the user sees what they paste.
 */
export function CodeBlockActions({
  code,
  paste = false,
}: {
  code: string;
  paste?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canPaste = paste && !UNPASTEABLE.test(code);
  // copyText writes the code exactly; copy() would trim its indentation.
  const { copied, copyText, confirmCopied } = useCopyFeedback(code);
  const pasting = useRef(false);

  const copy = async (): Promise<void> => {
    if (await copyText(code)) confirmCopied(code);
  };

  // The code exactly as shown, and never an Enter, so the user chooses when it runs. A second
  // press while it runs would paste the code twice.
  const pasteIntoApp = async (): Promise<void> => {
    if (pasting.current) return;
    pasting.current = true;
    try {
      const result = await window.electronAPI
        ?.pasteText?.(code, { raw: true, assistantTarget: true })
        .catch(() => null);
      if (result?.success && result.pasted) {
        toast({ title: t("skills.code.pasted"), variant: "success" });
        return;
      }
      // A clipboard-only paste and a missing Accessibility permission leave it on the
      // clipboard already; after any other failure, or with the app no longer there to paste
      // into, it is put there.
      if (!result || result.reason === "no-target") await copyText(code);
      toast({ title: t("skills.code.pasteFailed") });
    } finally {
      pasting.current = false;
    }
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
        {canPaste && (
          <Button size="sm" variant="outline" onClick={() => void pasteIntoApp()}>
            <Terminal className="h-3.5 w-3.5" />
            {t("skills.code.paste")}
          </Button>
        )}
      </div>
      {/* Not a <p>: a host's paragraph styles would resize it. */}
      {canPaste && (
        <div className="mt-1.5 text-[11px] text-muted-foreground/80">
          {t("skills.code.pasteNote")}
        </div>
      )}
    </div>
  );
}
