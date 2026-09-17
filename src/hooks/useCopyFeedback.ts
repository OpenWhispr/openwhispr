import { useCallback, useEffect, useRef, useState } from "react";

export function useCopyFeedback(
  text: string,
  { resetMs = 1800 }: { resetMs?: number } = {}
): {
  copied: boolean;
  copy: () => Promise<void>;
  copyText: (textToCopy: string) => Promise<boolean>;
  confirmCopied: (copiedText: string, durationMs?: number) => void;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedTextRef = useRef<string | null>(null);

  useEffect(() => {
    if (confirmedTextRef.current === text) return;
    confirmedTextRef.current = null;
    setCopied(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [text]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const confirmCopied = useCallback(
    (copiedText: string, durationMs = resetMs) => {
      confirmedTextRef.current = copiedText;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), durationMs);
    },
    [resetMs]
  );

  // Writes without touching the copied state: the shared feedback belongs to
  // the full-text copy, not to a partial selection.
  const copyText = useCallback(async (textToCopy: string) => {
    if (!textToCopy.trim()) return false;

    try {
      const result = await window.electronAPI?.writeClipboard?.(textToCopy);
      if (result?.success === false) throw new Error("clipboard-write-failed");
      return true;
    } catch {
      try {
        await navigator.clipboard.writeText(textToCopy);
        return true;
      } catch {
        return false;
      }
    }
  }, []);

  const copy = useCallback(async () => {
    const textToCopy = text.trim();
    if (!textToCopy) return;

    if (!(await copyText(textToCopy))) {
      setCopied(false);
      return;
    }

    confirmCopied(text, resetMs);
  }, [confirmCopied, copyText, text, resetMs]);

  return { copied, copy, copyText, confirmCopied };
}
