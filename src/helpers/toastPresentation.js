export function resolveToastPresentation({ presentation, variant, isDictationPanel }) {
  if (presentation) return presentation;
  if (isDictationPanel && variant === "destructive") return "dictation-error";
  return "standard";
}

export function getDictationErrorActionCount(toasts) {
  const currentError = [...toasts]
    .reverse()
    .find((toast) => toast.presentation === "dictation-error");
  return currentError ? Math.max(1, currentError.actions?.length ?? 0) : 0;
}
