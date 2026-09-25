// ESM like meetingJoinUrl.js: shared with the renderer (the email_draft tool
// checks addresses) and loaded by the main-process email connector through
// require(esm).

export const COMPOSE_TARGETS = /** @type {const} */ ([
  "gmail",
  "outlookWork",
  "outlookPersonal",
  "mailto",
]);

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

// Undocumented but widely used compose deep links.
const COMPOSE_BASES = {
  gmail: "https://mail.google.com/mail/?view=cm&fs=1",
  outlookWork: "https://outlook.office.com/mail/deeplink/compose",
  outlookPersonal: "https://outlook.live.com/mail/0/deeplink/compose",
};

// Combining marks may follow a label's first character: Devanagari, Thai and
// Arabic with harakat spell words with them.
const EMAIL_ADDRESS_PATTERN =
  /^[^\s@<>()[\],;:"]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]*[\p{L}\p{N}\p{M}])?\.)+[\p{L}\p{N}-][\p{L}\p{N}\p{M}-]+$/u;

// The To field is the user's only look at the recipient, so nothing may hide
// or fake part of it: control, format, surrogate and default-ignorable
// characters are refused anywhere (a right-to-left override can make evil.io
// read as corp.com; a Hangul filler shows as nothing), and a domain label may
// not mix Latin, Cyrillic, Greek and Armenian, which share look-alike letters
// (cоrp with a Cyrillic о). A label written in one script (münchen, пример) is
// allowed; recipientLabel shows its punycode so a whole-script look-alike
// (аррӏе) stands out.
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
const LOOKALIKE_SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
];

function mixesLookalikeScripts(label) {
  return LOOKALIKE_SCRIPTS.filter((script) => script.test(label)).length > 1;
}

// The ASCII (punycode) form a mail server routes to, or null when the domain
// has no valid one. The URL API applies the same IDNA mapping in main and in
// the renderer.
function asciiDomain(domain) {
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

export function isValidEmailAddress(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !EMAIL_ADDRESS_PATTERN.test(value) ||
    HIDDEN_CHARACTER.test(value)
  ) {
    return false;
  }
  const domain = value.split("@")[1];
  return !domain.split(".").some(mixesLookalikeScripts) && asciiDomain(domain) !== null;
}

// How a recipient is shown to the user and the model: a non-ASCII domain also
// gets the ASCII form it routes to.
export function recipientLabel(address) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const ascii = /[^\x00-\x7F]/.test(domain) ? asciiDomain(domain) : null;
  return ascii ? `${address} (${ascii})` : address;
}

// Models often write "Josh Lee <josh@example.com>"; only the address inside
// the brackets is kept, so the name can't disguise it.
const DISPLAY_NAME_FORM = /^[^<>]*<([^<>]*)>$/;

// NFC, so a decomposed ü (u + combining diaeresis) is the same address as ü.
export function bareEmailAddress(value) {
  const trimmed = value.trim();
  return (trimmed.match(DISPLAY_NAME_FORM)?.[1].trim() ?? trimmed).normalize("NFC");
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

  if (target === "mailto") {
    // RFC 6068: line breaks in a mailto body are CRLF. A subject is one header
    // line, and some mail apps would read a line break in it as a new header.
    const encodedBody = body ? encodeURIComponent(body.replace(/\r\n|\r|\n/g, "\r\n")) : "";
    const mailtoSubject = subject ? encodeURIComponent(subject.replace(/[\r\n]+/g, " ")) : "";
    const query = joinQuery([
      ["cc", ccList],
      ["subject", mailtoSubject],
      ["body", encodedBody],
    ]);
    return `mailto:${toList}${query ? `?${query}` : ""}`;
  }

  const encodedSubject = subject ? encodeURIComponent(subject) : "";
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
  // A lone surrogate (half an emoji from a model) would make encodeURIComponent throw.
  subject = subject.toWellFormed();
  body = body.toWellFormed();
  const maxLength = maxComposeUrlLength(target, platform);
  const fits = (url) => url.length <= maxLength;

  const full = buildUrl(target, { to, cc, subject, body });
  if (fits(full)) {
    return { ok: true, url: full, clipboardText: null, subjectCopied: false, bodyCopied: false };
  }

  if (body) {
    const withoutBody = buildUrl(target, { to, cc, subject, body: "" });
    if (fits(withoutBody)) {
      return {
        ok: true,
        url: withoutBody,
        clipboardText: body,
        subjectCopied: false,
        bodyCopied: true,
      };
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
    bodyCopied: Boolean(body),
  };
}
