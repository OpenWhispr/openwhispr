// Harness and the framing, UTF-8 and Cc tests are ported from #1819's
// gmailManager.test.js (Gabriel Stein); the expectations follow spec §5.1
// (CRLF bodies, folded encoded-word subjects).
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/gmailMime.js");

const HEADER_NAMES = [
  "From",
  "To",
  "Cc",
  "Subject",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
];

function decodeRaw(raw) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

// Unfolds (RFC 5322 §2.2.3: drop a CRLF that precedes whitespace) before
// splitting, so a folded To or Subject reads as one header.
function splitMessage(raw) {
  const message = decodeRaw(raw);
  const end = message.indexOf("\r\n\r\n");
  assert.ok(end > 0, "the message must have a header block");
  const headerBlock = message.slice(0, end);
  return {
    headerBlock,
    headerLines: headerBlock.split("\r\n"),
    headers: headerBlock.replace(/\r\n(?=[ \t])/g, "").split("\r\n"),
    body: message.slice(end + 4),
  };
}

function headerNames(headers) {
  return headers.map((header) => header.slice(0, header.indexOf(":")));
}

function decodeBody(body) {
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

function subjectWords(headers) {
  const subject = headers.find((header) => header.startsWith("Subject: "));
  return subject.slice("Subject: ".length).split(" ");
}

function decodeWord(word) {
  const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(word);
  assert.ok(match, `not a UTF-8 B encoded word: ${word}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

const BASE = {
  from: "me@example.com",
  to: ["a@example.com"],
  subject: "Hello",
  body: "Hi",
};

test("buildRawMessage produces base64url with full RFC 2822 framing", async () => {
  const { buildRawMessage } = await load();
  const result = buildRawMessage({
    from: "me@example.com",
    to: ["a@example.com", "b@example.com"],
    cc: ["c@example.com"],
    subject: "Meeting follow-up",
    body: "Hi team,\nThanks for today.",
  });

  assert.equal(result.ok, true);
  assert.match(result.raw, /^[A-Za-z0-9_-]+$/, "raw must use the base64url alphabet only");
  assert.equal(result.bytes, result.raw.length);

  const { headers, body } = splitMessage(result.raw);
  assert.ok(headers.includes("From: me@example.com"));
  assert.ok(headers.includes("To: a@example.com, b@example.com"));
  assert.ok(headers.includes("Cc: c@example.com"));
  assert.ok(headers.includes("Subject: Meeting follow-up"));
  assert.ok(headers.includes("MIME-Version: 1.0"));
  assert.ok(headers.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(headers.includes("Content-Transfer-Encoding: base64"));
  assert.equal(decodeBody(body), "Hi team,\r\nThanks for today.");
});

test("the headers are exactly From, To, Cc, Subject and the three MIME headers, in order", async () => {
  const { buildRawMessage } = await load();
  const withCc = splitMessage(buildRawMessage({ ...BASE, cc: ["c@example.com"] }).raw);
  assert.deepEqual(headerNames(withCc.headers), HEADER_NAMES);

  const withoutCc = splitMessage(buildRawMessage(BASE).raw);
  assert.deepEqual(
    headerNames(withoutCc.headers),
    HEADER_NAMES.filter((name) => name !== "Cc")
  );
});

test("buildRawMessage omits the Cc header when there are no cc recipients", async () => {
  const { buildRawMessage } = await load();
  const { headers } = splitMessage(buildRawMessage({ ...BASE, cc: [] }).raw);
  assert.ok(!headers.some((header) => header.startsWith("Cc:")));
});

test("buildRawMessage RFC 2047-encodes non-ASCII subjects and preserves UTF-8 bodies", async () => {
  const { buildRawMessage } = await load();
  const { raw } = buildRawMessage({
    ...BASE,
    subject: "Résumé — 会議",
    body: "Danke schön — ありがとう",
  });

  const { headers, body } = splitMessage(raw);
  assert.equal(subjectWords(headers).map(decodeWord).join(""), "Résumé — 会議");
  assert.equal(decodeBody(body), "Danke schön — ありがとう");
});

test("CR or LF in any header value is refused, so no header can be added", async () => {
  const { buildRawMessage } = await load();
  const attempts = [
    { subject: "Hi\r\nBcc: x@y.com" },
    { subject: "Hi\nBcc: x@y.com" },
    { subject: "Hi\rBcc: x@y.com" },
    { subject: "Hi\r\n\r\nA different body" },
    { to: ["a@example.com\r\nBcc: x@y.com"] },
    { to: ["a@example.com", "b@example.com\nBcc: x@y.com"] },
    { cc: ["c@example.com\r\nBcc: x@y.com"] },
    { from: "me@example.com\r\nBcc: x@y.com" },
  ];
  for (const attempt of attempts) {
    const result = buildRawMessage({ ...BASE, ...attempt });
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.equal(result.errorCode, "header_injection", JSON.stringify(attempt));
    assert.equal(typeof result.message, "string");
    assert.equal("raw" in result, false);
  }
});

test("hostile subjects without line breaks never add a header and decode back exactly", async () => {
  const { buildRawMessage } = await load();
  const subjects = [
    "Bcc: x@y.com",
    "=?UTF-8?B?QmNjOiB4QHkuY29t?=",
    "Line separator and next\u0085line",
    "Tab\there and NUL\u0000there",
    "‮moc.live‬ spoofed direction",
    "   ",
  ];
  for (const subject of subjects) {
    const result = buildRawMessage({ ...BASE, subject });
    assert.equal(result.ok, true, JSON.stringify(subject));
    const { headers } = splitMessage(result.raw);
    assert.deepEqual(
      headerNames(headers),
      HEADER_NAMES.filter((name) => name !== "Cc"),
      JSON.stringify(subject)
    );
    const value = headers.find((header) => header.startsWith("Subject: ")).slice(9);
    const decoded = /^=\?UTF-8\?B\?/.test(value)
      ? subjectWords(headers).map(decodeWord).join("")
      : value;
    assert.equal(decoded, subject, JSON.stringify(subject));
  }
});

test("a long emoji, CJK and RTL subject becomes short, whole-character encoded words", async () => {
  const { buildRawMessage, encodeSubject } = await load();
  const subject = Array.from("👋🏽 会議のメモ مرحبا بالعالم שלום 👨‍👩‍👧 ".repeat(12))
    .slice(0, 200)
    .join("");
  assert.equal(Array.from(subject).length, 200);

  const encoded = encodeSubject(subject);
  const words = encoded.split("\r\n ");
  assert.ok(words.length > 1, "a long subject must be folded into several words");
  for (const word of words) {
    assert.ok(word.length <= 75, `encoded word over 75 characters: ${word.length}`);
    assert.equal(decodeWord(word).includes("�"), false, "a word split a character");
  }
  assert.equal(words.map(decodeWord).join(""), subject);

  const { headers, headerLines } = splitMessage(buildRawMessage({ ...BASE, subject }).raw);
  for (const line of headerLines) {
    assert.ok(line.length <= 78, `header line over 78 characters: ${line.length}`);
  }
  assert.equal(subjectWords(headers).map(decodeWord).join(""), subject);
});

test("printable ASCII subjects are left as they are", async () => {
  const { encodeSubject } = await load();
  assert.equal(encodeSubject("Q3 numbers (draft) & plan #2"), "Q3 numbers (draft) & plan #2");
  assert.equal(encodeSubject(""), "");
  assert.equal(encodeSubject("x".repeat(250)), "x".repeat(250));
});

test("addresses must be bare and valid: names, hidden characters and lists are refused", async () => {
  const { buildRawMessage } = await load();
  const attempts = [
    { to: ["Josh Lee <josh@example.com>"] },
    { to: ["josh@example.com, evil@example.com"] },
    { to: ["jo​sh@example.com"] },
    { to: ["josh@exa‮mple.com"] },
    { to: ["josh@cоrp.com"] },
    { to: ["not-an-address"] },
    { to: [] },
    { to: [42] },
    { to: "a@example.com" },
    { cc: ["Dana <dana@example.com>"] },
    { cc: "c@example.com" },
    { from: "Me <me@example.com>" },
    { from: undefined },
  ];
  for (const attempt of attempts) {
    const result = buildRawMessage({ ...BASE, ...attempt });
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.equal(result.errorCode, "invalid_recipients", JSON.stringify(attempt));
    assert.equal("raw" in result, false);
  }
});

// Task 6 controller ruling: the CR/LF check (LINE_BREAK) only catches \r and
// \n. Any other C0 control character in an address must still be kept out of
// the header line verbatim — here it's caught by isValidEmailAddress's
// hidden-character check (\p{Cc}), inherited from emailCompose.js, before the
// header is ever built.
test("other C0 control characters in an address are refused, not written into a header", async () => {
  const { buildRawMessage } = await load();
  const attempts = [
    { to: ["a\u0000b@example.com"] },
    { to: ["a\u000Bb@example.com"] },
    { to: ["a\u000Cb@example.com"] },
    { to: ["a\u001Bb@example.com"] },
    { cc: ["a\u0000b@example.com"] },
    { from: "a\u0000b@example.com" },
  ];
  for (const attempt of attempts) {
    const result = buildRawMessage({ ...BASE, ...attempt });
    assert.equal(result.ok, false, JSON.stringify(attempt));
    assert.equal(result.errorCode, "invalid_recipients", JSON.stringify(attempt));
    assert.equal("raw" in result, false);
  }
});

test("internationalized domains go into the headers in ASCII; local parts stay as given", async () => {
  const { buildRawMessage } = await load();
  const result = buildRawMessage({
    from: "me@bücher.example",
    to: ["a@münchen.de", "иван@пример.рф"],
    cc: ["d@Example.COM"],
    subject: "Hallo",
    body: "Hi",
  });

  assert.equal(result.ok, true);
  const { headers } = splitMessage(result.raw);
  assert.ok(headers.includes("From: me@xn--bcher-kva.example"));
  assert.ok(headers.includes("To: a@xn--mnchen-3ya.de, иван@xn--e1afmkfd.xn--p1ai"));
  assert.ok(headers.includes("Cc: d@example.com"));
});

test("fifty long recipients fold one per line and read back as the same list", async () => {
  const { buildRawMessage } = await load();
  const to = Array.from(
    { length: 30 },
    (_, index) => `recipient.${index}.${"x".repeat(40)}@example.com`
  );
  const cc = Array.from(
    { length: 20 },
    (_, index) => `copy.${index}.${"y".repeat(40)}@example.org`
  );

  const { headers, headerLines } = splitMessage(buildRawMessage({ ...BASE, to, cc }).raw);

  for (const line of headerLines) {
    assert.ok(line.length <= 998, `header line over 998 characters: ${line.length}`);
  }
  assert.equal(
    headers.find((header) => header.startsWith("To: ")),
    `To: ${to.join(", ")}`
  );
  assert.equal(
    headers.find((header) => header.startsWith("Cc: ")),
    `Cc: ${cc.join(", ")}`
  );
});

test("the body is CRLF-normalised and decodes back exactly, wrapped at 76 columns", async () => {
  const { buildRawMessage } = await load();
  const longLine = "word ".repeat(2000);
  const body = `One\nTwo\r\nThree\rFour\n\nSix\u0000seven\r\r\n${longLine}\nمرحبا 👋🏽`;
  const expected = `One\r\nTwo\r\nThree\r\nFour\r\n\r\nSix\u0000seven\r\n\r\n${longLine}\r\nمرحبا 👋🏽`;

  const result = buildRawMessage({ ...BASE, body: `${body}\r\n\r\nBcc: x@y.com` });
  const { headers, body: encoded } = splitMessage(result.raw);

  assert.equal(decodeBody(encoded), `${expected}\r\n\r\nBcc: x@y.com`);
  for (const line of encoded.split("\r\n")) {
    assert.match(line, /^[A-Za-z0-9+/=]{1,76}$/);
  }
  assert.deepEqual(
    headerNames(headers),
    HEADER_NAMES.filter((name) => name !== "Cc")
  );
});

test("an empty body still builds a valid message", async () => {
  const { buildRawMessage } = await load();
  const result = buildRawMessage({ ...BASE, body: "" });
  assert.equal(result.ok, true);
  assert.equal(splitMessage(result.raw).body, "");
});

test("the largest email the card allows still fits the raw cap", async () => {
  const { buildRawMessage, MAX_RAW_BYTES } = await load();
  const { MAX_EMAIL_BODY_BYTES, MAX_EMAIL_RECIPIENTS, MAX_EMAIL_SUBJECT_LENGTH, emailBodyBytes } =
    await import("../../../src/helpers/connectors/emailCompose.js");
  // The longest local part (64 bytes, RFC 5321) on internationalized
  // domains, which grow in punycode.
  const address = (index) =>
    `${String(index).padStart(2, "0")}${"l".repeat(62)}@${"ü".repeat(55)}.${"ü".repeat(55)}.${"ü".repeat(55)}.de`;
  const body = "é".repeat(MAX_EMAIL_BODY_BYTES / 2);
  assert.equal(emailBodyBytes(body), MAX_EMAIL_BODY_BYTES);

  const built = buildRawMessage({
    from: address(99),
    to: Array.from({ length: MAX_EMAIL_RECIPIENTS }, (_, index) => address(index)),
    subject: "😀".repeat(MAX_EMAIL_SUBJECT_LENGTH),
    body,
  });
  assert.equal(built.ok, true);
  assert.ok(built.bytes <= MAX_RAW_BYTES);
});

test("a message whose raw form passes 1 MB is refused as too_long", async () => {
  const { buildRawMessage, MAX_RAW_BYTES } = await load();
  assert.equal(MAX_RAW_BYTES, 1024 * 1024);

  const under = buildRawMessage({ ...BASE, body: "a".repeat(500_000) });
  assert.equal(under.ok, true);
  assert.ok(under.bytes <= MAX_RAW_BYTES);
  assert.equal(under.bytes, under.raw.length);

  const over = buildRawMessage({ ...BASE, body: "a".repeat(800_000) });
  assert.deepEqual(Object.keys(over).sort(), ["errorCode", "message", "ok"]);
  assert.equal(over.ok, false);
  assert.equal(over.errorCode, "too_long");
});
