const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/helpers/connectors/emailCompose.js");

const TRICKY = {
  to: ["gabe+lunch@example.com", "dana@example.org"],
  cc: ["o'neil@example.com"],
  subject: "Lunch 🍜 & plans #1 — 50% off?",
  body: "Hi Gabe,\n\nمرحبا — a+b=c & 100% sure? #yes\nSee you!",
};

test("web targets round-trip every field exactly", async () => {
  const { buildComposeRequest } = await load();
  const expected = {
    gmail: { host: "mail.google.com", subjectKey: "su" },
    outlookWork: { host: "outlook.office.com", subjectKey: "subject" },
    outlookPersonal: { host: "outlook.live.com", subjectKey: "subject" },
  };
  for (const [target, { host, subjectKey }] of Object.entries(expected)) {
    const { url, clipboardText } = buildComposeRequest({ target, ...TRICKY });
    const parsed = new URL(url);
    assert.equal(parsed.host, host, target);
    assert.equal(parsed.searchParams.get("to"), TRICKY.to.join(","), target);
    assert.equal(parsed.searchParams.get("cc"), TRICKY.cc.join(","), target);
    assert.equal(parsed.searchParams.get(subjectKey), TRICKY.subject, target);
    assert.equal(parsed.searchParams.get("body"), TRICKY.body, target);
    assert.equal(clipboardText, null, target);
  }
});

test("mailto keeps addresses readable and uses CRLF line breaks", async () => {
  const { buildComposeRequest } = await load();
  const { url } = buildComposeRequest({ target: "mailto", ...TRICKY });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "mailto:");
  assert.equal(decodeURIComponent(parsed.pathname), TRICKY.to.join(","));
  assert.equal(parsed.searchParams.get("subject"), TRICKY.subject);
  assert.equal(parsed.searchParams.get("body"), TRICKY.body.replace(/\n/g, "\r\n"));
  assert.match(url, /^mailto:gabe%2Blunch@example\.com,dana@example\.org\?/);
});

test("mailto turns every kind of line break into CRLF and keeps the subject on one line", async () => {
  const { buildComposeRequest } = await load();
  const { url } = buildComposeRequest({
    target: "mailto",
    to: ["a@example.com"],
    subject: "Hi\r\nBcc: evil@example.com",
    body: "one\rtwo\nthree\r\nfour",
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("subject"), "Hi Bcc: evil@example.com");
  assert.equal(parsed.searchParams.get("body"), "one\r\ntwo\r\nthree\r\nfour");
});

test("empty fields are left out of the URL", async () => {
  const { buildComposeRequest } = await load();
  const { url } = buildComposeRequest({ target: "outlookWork", to: ["a@example.com"] });
  assert.equal(url, "https://outlook.office.com/mail/deeplink/compose?to=a@example.com");
});

test("a body that would push the URL past the limit moves to the clipboard", async () => {
  const { buildComposeRequest } = await load();
  const body = "é".repeat(400);
  const { url, clipboardText, bodyCopied } = buildComposeRequest({
    target: "gmail",
    to: ["a@example.com"],
    subject: "Notes",
    body,
  });
  assert.equal(clipboardText, body);
  assert.equal(bodyCopied, true);
  assert.equal(new URL(url).searchParams.get("body"), null);
  assert.equal(new URL(url).searchParams.get("su"), "Notes");
  assert.ok(url.length <= 2000);
});

test("a body that fits stays in the URL", async () => {
  const { buildComposeRequest } = await load();
  const body = "x".repeat(1500);
  const { url, clipboardText } = buildComposeRequest({
    target: "mailto",
    to: ["a@example.com"],
    body,
  });
  assert.equal(clipboardText, null);
  assert.equal(new URL(url).searchParams.get("body"), body);
});

test("a subject too long for any link moves to the clipboard, even with no body", async () => {
  const { buildComposeRequest } = await load();
  const subject = "Quarterly planning ".repeat(120).trim();
  for (const body of ["", "See the agenda below."]) {
    const result = buildComposeRequest({
      target: "outlookWork",
      to: ["a@example.com"],
      subject,
      body,
    });
    assert.equal(result.ok, true);
    assert.equal(result.subjectCopied, true);
    assert.equal(result.clipboardText, body ? `${subject}\n\n${body}` : subject);
    assert.equal(result.bodyCopied, Boolean(body));
    assert.equal(new URL(result.url).searchParams.get("subject"), null);
    assert.ok(result.url.length <= 2000);
  }
});

test("recipients too long for any link are refused instead of opening a broken link", async () => {
  const { buildComposeRequest } = await load();
  const to = Array.from({ length: 120 }, (_, i) => `teammate.number.${i}@example.com`);
  assert.deepEqual(buildComposeRequest({ target: "mailto", to, subject: "Hi", body: "Hello" }), {
    ok: false,
    reason: "too_long",
  });
});

test("no returned link ever exceeds the limit", async () => {
  const { buildComposeRequest, COMPOSE_TARGETS, maxComposeUrlLength } = await load();
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const target of COMPOSE_TARGETS) {
      const limit = maxComposeUrlLength(target, platform);
      for (const recipients of [1, 10, 40, 80]) {
        for (const subjectLength of [0, 50, 900, 2500]) {
          for (const bodyLength of [0, 300, 1900, 5000]) {
            const result = buildComposeRequest({
              target,
              to: Array.from({ length: recipients }, (_, i) => `person${i}@example.com`),
              subject: "ü".repeat(subjectLength),
              body: "é ".repeat(bodyLength),
              platform,
            });
            if (result.ok) {
              assert.ok(
                result.url.length <= limit,
                `${platform} ${target} ${recipients}/${subjectLength}/${bodyLength}: ${result.url.length}`
              );
            }
          }
        }
      }
    }
  }
});

test("Gmail on macOS and Linux keeps a longer non-ASCII body in the link", async () => {
  const { buildComposeRequest, maxComposeUrlLength } = await load();
  // ~500 Cyrillic characters encode to ~5,000 URL characters.
  const body = "Привет, это письмо. ".repeat(25);
  const request = (target, platform) =>
    buildComposeRequest({ target, to: ["a@example.com"], subject: "Notes", body, platform });

  for (const platform of ["darwin", "linux"]) {
    const { url, clipboardText } = request("gmail", platform);
    assert.equal(clipboardText, null, platform);
    assert.equal(new URL(url).searchParams.get("body"), body, platform);
    assert.ok(url.length <= maxComposeUrlLength("gmail", platform));
  }
  // Windows caps every opened URL near 2,081; the other targets are unmeasured.
  assert.equal(request("gmail", "win32").clipboardText, body);
  assert.equal(request("outlookWork", "darwin").clipboardText, body);
  assert.equal(request("mailto", "linux").clipboardText, body);
  assert.equal(maxComposeUrlLength("gmail", undefined), 2000);
});

test("email address validation", async () => {
  const { isValidEmailAddress } = await load();
  for (const good of [
    "a@example.com",
    "gabe+lunch@example.co.uk",
    "o'neil@example.com",
    "josé@münchen.de",
    "a@xn--80ak6aa92e.com",
    "info@пример.рф",
    "a@παράδειγμα.gr",
    "first.last@sub-domain.example.org",
  ]) {
    assert.equal(isValidEmailAddress(good), true, good);
  }
  for (const bad of [
    "Gabe",
    "gabe@",
    "@example.com",
    "a@b",
    "a b@example.com",
    "a@example.com,b@example.com",
    "",
    null,
  ]) {
    assert.equal(isValidEmailAddress(bad), false, String(bad));
  }
});

test("addresses that could disguise the recipient or carry URL junk are refused", async () => {
  const { isValidEmailAddress } = await load();
  for (const bad of [
    "‮moc.proc@evil.io", // right-to-left override: displays as oi.live@corp.com
    "alice@corp.com​.evil.io", // zero-width space
    "alice‍@corp.com", // zero-width joiner
    "alice\u0000@corp.com",
    "alice\u0007@corp.com",
    "a@b.com?subject=x",
    "a@b.com#frag",
    "a@b.com&",
    "a@b..com",
    "a@b.com/../x",
    "a@-corp.com",
    "alice@corp\u3164.com", // Hangul filler: a letter that renders as nothing
    "alice@corp.com\u3164",
    "alice\u034F@corp.com", // combining grapheme joiner
    "alice@corp\u2060.com", // word joiner
    "alice@c\u043Erp.com", // Cyrillic о inside a Latin label
    "alice@\u03B1pple.com", // Greek α inside a Latin label
  ]) {
    assert.equal(isValidEmailAddress(bad), false, JSON.stringify(bad));
  }
});

test("a display-name form keeps only the address inside the brackets", async () => {
  const { bareEmailAddress } = await load();
  assert.equal(bareEmailAddress("Josh Lee <josh@example.com>"), "josh@example.com");
  assert.equal(bareEmailAddress(' "Lee, Josh" < josh@example.com > '), "josh@example.com");
  assert.equal(bareEmailAddress("  josh@example.com "), "josh@example.com");
  // Anything else is left for the validator to refuse.
  assert.equal(
    bareEmailAddress("Josh <josh@example.com> <evil@example.com>"),
    "Josh <josh@example.com> <evil@example.com>"
  );
  assert.equal(bareEmailAddress("Josh"), "Josh");
});

test("an unknown target is rejected", async () => {
  const { buildComposeRequest } = await load();
  assert.throws(
    () => buildComposeRequest({ target: "yahoo", to: ["a@example.com"] }),
    /Unknown compose target/
  );
});
