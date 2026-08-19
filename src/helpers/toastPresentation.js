// Only callers that ask for the shared error surface get it. A destructive
// variant alone is a red toast: promoting every destructive notice (mic
// disconnect, cleanup failure, hotkey/GPU fallback) hid the pill, resized the
// window and tore down the live transcript for unrelated notices.
/**
 * @param {{ presentation?: string, variant?: string, isDictationPanel?: boolean }} options
 *   variant/isDictationPanel are accepted for callers that still pass them
 *   (e.g. Toast.tsx) but are no longer read here.
 */
export function resolveToastPresentation({ presentation }) {
  return presentation === "dictation-error" ? "dictation-error" : "standard";
}

export function getDictationErrorActionCount(toasts) {
  const currentError = [...toasts]
    .reverse()
    .find((toast) => toast.presentation === "dictation-error");
  return currentError ? Math.max(1, currentError.actions?.length ?? 0) : 0;
}

const SHORT_MESSAGE_MAX_LENGTH = 90;
const MEDIUM_MESSAGE_MAX_LENGTH = 180;

/** Keep short errors brief while giving detailed failures enough reading time. */
export function getDictationErrorDuration(title = "", description = "") {
  const messageLength = [title, description].filter(Boolean).join(" ").trim().length;

  if (messageLength <= SHORT_MESSAGE_MAX_LENGTH) return 3000;
  if (messageLength <= MEDIUM_MESSAGE_MAX_LENGTH) return 4000;
  return 5000;
}
