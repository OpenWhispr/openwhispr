const SHORT_MESSAGE_MAX_LENGTH = 90;
const MEDIUM_MESSAGE_MAX_LENGTH = 180;

/** Keep short errors brief while giving detailed failures enough reading time. */
export function getDictationErrorDuration(title = "", description = "") {
  const messageLength = [title, description].filter(Boolean).join(" ").trim().length;

  if (messageLength <= SHORT_MESSAGE_MAX_LENGTH) return 3000;
  if (messageLength <= MEDIUM_MESSAGE_MAX_LENGTH) return 4000;
  return 5000;
}
