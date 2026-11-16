// Builds the base64url `raw` message that Gmail's messages.send takes.
// Ported from #1819's buildRawMessage (Gabriel Stein), with the spec §5.1
// fixes: a header value holding CR or LF is refused, so model text can't add
// a header; addresses must be bare and pass isValidEmailAddress; non-ASCII
// subjects become bounded RFC 2047 encoded words; the body is CRLF-normalised.
const { isValidEmailAddress, asciiDomain } = require("./emailCompose");

// Our cap on the finished `raw` string (ASCII, so length is bytes).
const MAX_RAW_BYTES = 1024 * 1024;

// 39 UTF-8 bytes encode to 52 base64 characters, so a word with its
// "=?UTF-8?B?" and "?=" is 64 characters: under RFC 2047's 75, and
// "Subject: " plus the first word stays under RFC 5322's 78-character line.
const MAX_WORD_BYTES = 39;
const BODY_LINE_LENGTH = 76;
const LINE_BREAK = /[\r\n]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// "=?" in a plain subject would be decoded as an encoded word by the
// recipient's mail client, showing them something other than the card did.
function encodeSubject(subject) {
  if (PRINTABLE_ASCII.test(subject) && !subject.includes("=?")) return subject;
  const words = [];
  let word = "";
  let wordBytes = 0;
  // for…of walks code points, so a word never ends inside a UTF-8 sequence
  // or a surrogate pair (RFC 2047 §5: each word decodes to whole characters).
  for (const character of subject) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (wordBytes + bytes > MAX_WORD_BYTES) {
      words.push(word);
      word = "";
      wordBytes = 0;
    }
    word += character;
    wordBytes += bytes;
  }
  words.push(word);
  return words
    .map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

// The header carries the domain in the ASCII (punycode) form mail servers
// route to, using emailCompose.js's asciiDomain (the same conversion
// isValidEmailAddress already relies on); the local part stays as given
// (Gmail accepts non-ASCII local parts over SMTPUTF8). The card and receipts
// keep the Unicode form. Null when the domain can't be converted.
function headerAddress(address) {
  const at = address.lastIndexOf("@");
  const domain = asciiDomain(address.slice(at + 1));
  return domain === null ? null : `${address.slice(0, at)}@${domain}`;
}

function refuse(errorCode, message) {
  return { ok: false, errorCode, message };
}

function buildRawMessage({ from, to, cc = [], subject, body }) {
  const subjectText = String(subject ?? "");
  const bodyText = String(body ?? "");
  if (!Array.isArray(to) || !Array.isArray(cc)) {
    return refuse("invalid_recipients", "To and Cc must be lists of email addresses.");
  }
  const addresses = [from, ...to, ...cc];
  if (addresses.some((address) => typeof address !== "string")) {
    return refuse("invalid_recipients", "Every address must be a string.");
  }
  if ([...addresses, subjectText].some((value) => LINE_BREAK.test(value))) {
    return refuse("header_injection", "A header value contains a line break.");
  }
  if (to.length === 0) return refuse("invalid_recipients", "The email has no recipient.");
  if (!addresses.every(isValidEmailAddress)) {
    return refuse("invalid_recipients", "An address isn't a valid email address.");
  }
  const [fromHeader, ...recipientHeaders] = addresses.map(headerAddress);
  if (fromHeader === null || recipientHeaders.includes(null)) {
    return refuse("invalid_recipients", "An address's domain can't be written in ASCII.");
  }
  const toHeader = recipientHeaders.slice(0, to.length);
  const ccHeader = recipientHeaders.slice(to.length);
  // One address per folded line keeps a 50-recipient To under the 998
  // characters RFC 5322 allows on a line.
  const headers = [
    `From: ${fromHeader}`,
    `To: ${toHeader.join(",\r\n ")}`,
    ...(ccHeader.length > 0 ? [`Cc: ${ccHeader.join(",\r\n ")}`] : []),
    `Subject: ${encodeSubject(subjectText)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  // RFC 2045 §6.8: text is canonical CRLF before it is base64-encoded.
  const canonicalBody = bodyText.replace(/\r\n|\r|\n/g, "\r\n");
  const encodedBody = Buffer.from(canonicalBody, "utf8").toString("base64");
  const bodyLines = encodedBody.match(new RegExp(`.{1,${BODY_LINE_LENGTH}}`, "g")) ?? [];
  const message = `${headers.join("\r\n")}\r\n\r\n${bodyLines.join("\r\n")}`;
  const raw = Buffer.from(message, "utf8").toString("base64url");
  if (raw.length > MAX_RAW_BYTES) {
    return refuse("too_long", "The email is too large to send.");
  }
  return { ok: true, raw, bytes: raw.length };
}

module.exports = { buildRawMessage, encodeSubject, MAX_RAW_BYTES };
