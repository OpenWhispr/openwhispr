import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copies `text` to the clipboard (native bridge first, web API fallback) and
 * latches `copied` for `resetMs`. The latch clears immediately when the source
 * text changes so stale feedback never survives a new answer.
 */
export function useCopyFeedback(
  text: string,
  { resetMs = 1800 }: { resetMs?: number } = {}
): { copied: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setCopied(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [text]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const copy = useCallback(async () => {
    const textToCopy = text.trim();
    if (!textToCopy) return;

    try {
      const result = await window.electronAPI?.writeClipboard?.(textToCopy);
      if (result?.success === false) throw new Error("clipboard-write-failed");
    } catch {
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch {
        setCopied(false);
        return;
      }
    }

    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), resetMs);
  }, [text, resetMs]);

  return { copied, copy };
}
