// Loose client-side email shape check: non-empty local part, "@", domain with a dot.
// The server is the source of truth; this only guards obviously malformed input.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
