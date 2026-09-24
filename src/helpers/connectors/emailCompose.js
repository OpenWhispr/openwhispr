// ESM like meetingJoinUrl.js: shared with the renderer (the email_draft tool
// checks addresses) and loaded by the main-process email connector through
// require(esm).

export const COMPOSE_TARGETS = ["gmail", "outlookWork", "outlookPersonal", "mailto"];

// Windows caps every URL shell.openExternal opens at 2,081 characters, and
// the Outlook links and mailto handlers are unmeasured, so they stay at
// 2,000. Gmail on macOS and Linux takes much longer links (checked 2026-09-24:
// 6,000 characters open, even through the signed-out redirect; 12,000 is an
// HTTP 400), which matters because every non-ASCII character costs 6 to 12.
const DEFAULT_COMPOSE_URL_LENGTH = 2000;
const GMAIL_COMPOSE_URL_LENGTH = 6000;

export function maxComposeUrlLength(target, platform) {
  return target === "gmail" && (platform === "darwin" || platform === "linux")
    ? GMAIL_COMPOSE_URL_LENGTH
    : DEFAULT_COMPOSE_URL_LENGTH;
}

// Undocumented but widely used compose deep links (spec §7.1, [S9][S10]).
const COMPOSE_BASES = {
  gmail: "https://mail.google.com/mail/?view=cm&fs=1",
  outlookWork: "https://outlook.office.com/mail/deeplink/compose",
  outlookPersonal: "https://outlook.live.com/mail/0/deeplink/compose",
};

const EMAIL_ADDRESS_PATTERN = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]{2,}$/;

export function isValidEmailAddress(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_ADDRESS_PATTERN.test(value);
}

function encodeAddresses(addresses) {
  return addresses.map((address) => encodeURIComponent(address).replace(/%40/g, "@")).join(",");
}

function joinQuery(pairs) {
  return pairs
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function buildUrl(target, { to, cc, subject, body }) {
  const toList = encodeAddresses(to);
  const ccList = cc.length > 0 ? encodeAddresses(cc) : "";
  const encodedSubject = subject ? encodeURIComponent(subject) : "";

  if (target === "mailto") {
    // RFC 6068: line breaks in a mailto body are CRLF.
    const encodedBody = body ? encodeURIComponent(body.replace(/\r?\n/g, "\r\n")) : "";
    const query = joinQuery([
      ["cc", ccList],
      ["subject", encodedSubject],
      ["body", encodedBody],
    ]);
    return `mailto:${toList}${query ? `?${query}` : ""}`;
  }

  const encodedBody = body ? encodeURIComponent(body) : "";
  if (target === "gmail") {
    const query = joinQuery([
      ["to", toList],
      ["cc", ccList],
      ["su", encodedSubject],
      ["body", encodedBody],
    ]);
    return `${COMPOSE_BASES.gmail}&${query}`;
  }

  const query = joinQuery([
    ["to", toList],
    ["cc", ccList],
    ["subject", encodedSubject],
    ["body", encodedBody],
  ]);
  return `${COMPOSE_BASES[target]}?${query}`;
}

// Every returned URL fits the limit. What doesn't fit moves to the clipboard,
// body first, then subject; recipients that alone don't fit are refused.
export function buildComposeRequest({ target, to, cc = [], subject = "", body = "", platform }) {
  if (!COMPOSE_TARGETS.includes(target)) throw new Error(`Unknown compose target: ${target}`);
  const maxLength = maxComposeUrlLength(target, platform);
  const fits = (url) => url.length <= maxLength;

  const full = buildUrl(target, { to, cc, subject, body });
  if (fits(full)) return { ok: true, url: full, clipboardText: null, subjectCopied: false };

  if (body) {
    const withoutBody = buildUrl(target, { to, cc, subject, body: "" });
    if (fits(withoutBody)) {
      return { ok: true, url: withoutBody, clipboardText: body, subjectCopied: false };
    }
  }

  const recipientsOnly = buildUrl(target, { to, cc, subject: "", body: "" });
  if (!fits(recipientsOnly)) return { ok: false, reason: "too_long" };
  const clipboardText = [subject, body].filter(Boolean).join("\n\n");
  return {
    ok: true,
    url: recipientsOnly,
    clipboardText: clipboardText || null,
    subjectCopied: Boolean(subject),
  };
}
