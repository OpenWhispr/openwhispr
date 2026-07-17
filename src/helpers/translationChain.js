// Pure orchestration for the cleanup-then-translate chain. No imports: callers
// inject the actual cleanup/translate calls and logging so this stays node-testable.

// Whether the translate step should run: skip only when an explicit source language
// equals the target. "auto" (or empty, treated as auto) always translates.
export function shouldRunTranslateStep(sourceLanguage, targetLanguage) {
  return (sourceLanguage || "auto") === "auto" || sourceLanguage !== targetLanguage;
}

// Step 1 (optional cleanup) soft-fails to the input text; Step 2 translates unless
// shouldTranslate is false. usedCloudReasoning tracks whether a cloud step actually ran.
export async function executeTranslationChain({
  text,
  cleanupReachable,
  cleanupIsCloud = false,
  runCleanup,
  runTranslate,
  shouldTranslate,
  translateIsCloud = false,
  onCleanupError,
  onEmptyTranslate,
}) {
  let out = text;
  let usedCloudReasoning = false;

  if (cleanupReachable) {
    try {
      const cleaned = await runCleanup(out);
      if (cleaned) out = cleaned;
      // Cloud cleanup counts as cloud reasoning once its call succeeds, even if it
      // returned empty text.
      if (cleanupIsCloud) usedCloudReasoning = true;
    } catch (cleanupError) {
      if (onCleanupError) onCleanupError(cleanupError);
    }
  }

  if (shouldTranslate) {
    const translated = await runTranslate(out);
    if (translated) {
      out = translated;
    } else if (onEmptyTranslate) {
      onEmptyTranslate();
    }
    if (translateIsCloud) usedCloudReasoning = true;
  }

  return { text: out, usedCloudReasoning };
}
