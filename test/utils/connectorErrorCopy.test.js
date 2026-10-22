const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let connectorErrorCopyKey;

test.before(async () => {
  ({ connectorErrorCopyKey } = await import("../../src/utils/connectorErrorCopy.ts"));
});

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).connectors;

test("codes with their own copy map to themselves", () => {
  for (const code of [
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "reconnect_needed",
    "connection_changed",
    "rate_limited",
    "missing_scope",
    "msg_too_long",
    "no_text",
    "credential_save_failed",
    "open_failed",
    "draft_too_long",
    "invalid_address",
  ]) {
    assert.equal(connectorErrorCopyKey(code), code);
  }
});

test("a refused or revoked login reads as reconnect_needed, Slack's other spelling as rate_limited", () => {
  for (const code of ["invalid_auth", "account_inactive", "not_authed", "token_revoked"]) {
    assert.equal(connectorErrorCopyKey(code), "reconnect_needed", code);
  }
  assert.equal(connectorErrorCopyKey("ratelimited"), "rate_limited");
});

test("a request that never reached Slack, or a refresh Slack couldn't answer, reads as network", () => {
  for (const code of [
    "ENOTFOUND",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ECONNRESET",
    "ERR_INTERNET_DISCONNECTED",
    "UND_ERR_CONNECT_TIMEOUT",
    "network_error",
    "timeout",
    "http_500",
    "http_503",
    "internal_error",
    "service_unavailable",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "network", code);
  }
});

test("a DM Slack wouldn't open reads as dm_failed", () => {
  for (const code of [
    "user_not_found",
    "user_not_visible",
    "user_disabled",
    "cannot_dm_bot",
    "not_enough_users",
    "too_many_users",
    "users_list_not_supplied",
    "method_not_supported_for_channel_type",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "dm_failed", code);
  }
});

test("a read-only or restricted channel reads as restricted", () => {
  for (const code of [
    "restricted_action",
    "restricted_action_read_only_channel",
    "ekm_access_denied",
  ]) {
    assert.equal(connectorErrorCopyKey(code), "restricted", code);
  }
});

test("everything else, including a missing code, reads as generic", () => {
  for (const code of [
    "invalid_arguments",
    "http_400",
    "http_404",
    "bad_response",
    "action_failed",
    "clipboard_unreserved",
    "weird_code",
    "constructor",
    "__proto__",
    "",
    undefined,
    null,
  ]) {
    assert.equal(connectorErrorCopyKey(code), "generic", String(code));
  }
});

test("every key the card and the tool step can show has English copy", () => {
  const cardKeys = [
    "not_in_channel",
    "channel_not_found",
    "is_archived",
    "reconnect_needed",
    "connection_changed",
    "rate_limited",
    "missing_scope",
    "msg_too_long",
    "no_text",
    "credential_save_failed",
    "network",
    "dm_failed",
    "restricted",
    "generic",
  ];
  const emailOnlyKeys = ["open_failed", "draft_too_long", "invalid_address"];
  for (const key of cardKeys) {
    assert.equal(typeof en.approval.errors[key], "string", `approval.errors.${key}`);
  }
  for (const key of [...cardKeys, ...emailOnlyKeys]) {
    assert.equal(typeof en.toolStatus.errors[key], "string", `toolStatus.errors.${key}`);
  }
});

const GMAIL_CODES = [
  "reconnect_needed",
  "network",
  "rate_limited",
  "daily_limit",
  "domain_policy",
  "invalid_recipients",
  "too_many_recipients",
  "too_long",
  "invalid_message",
  "gmail_unavailable",
  "refused",
  "connection_changed",
  "credential_save_failed",
];

test("Gmail has its own copy for every code it reports, on the card and in the tool step", () => {
  assert.deepEqual(Object.keys(en.approval.errors.gmail).sort(), [...GMAIL_CODES].sort());
  assert.deepEqual(Object.keys(en.toolStatus.errors.gmail).sort(), [...GMAIL_CODES].sort());
  for (const scope of [en.approval.errors.gmail, en.toolStatus.errors.gmail]) {
    for (const code of GMAIL_CODES) {
      assert.doesNotMatch(scope[code], /Slack/, code);
    }
  }
});

// Resolves keys against the English file the way i18next does: a missing
// key falls back to its defaultValue.
function englishT(key, options = {}) {
  const value = key.split(".").reduce((node, part) => node?.[part], { connectors: en });
  return typeof value === "string" ? value : (options.defaultValue ?? key);
}

test("a connector's own copy wins, by exact code first, then by shared copy key", async () => {
  const { connectorErrorText } = await import("../../src/utils/connectorErrorCopy.ts");
  const card = (connectorId, code) => connectorErrorText(englishT, "approval", connectorId, code);

  assert.equal(card("gmail", "daily_limit"), en.approval.errors.gmail.daily_limit);
  assert.equal(card("gmail", "ENOTFOUND"), en.approval.errors.gmail.network);
  assert.equal(card("gmail", "reconnect_needed"), en.approval.errors.gmail.reconnect_needed);
  // A code Gmail has no copy for gets the shared copy.
  assert.equal(card("gmail", "no_text"), en.approval.errors.no_text);
  assert.equal(card("gmail", "weird_code"), en.approval.errors.generic);
  assert.equal(card("gmail", undefined), en.approval.errors.generic);
  // Connectors without their own copy, or no connector, are unchanged.
  assert.equal(card("slack", "reconnect_needed"), en.approval.errors.reconnect_needed);
  assert.equal(card("", "daily_limit"), en.approval.errors.generic);
  assert.equal(
    connectorErrorText(englishT, "toolStatus", "gmail", "timeout"),
    en.toolStatus.errors.gmail.network
  );
});

test("a code named after an object property gets the generic copy, not the property", async () => {
  const { connectorErrorText } = await import("../../src/utils/connectorErrorCopy.ts");
  const i18next = (await import("i18next")).default.createInstance();
  await i18next.init({
    lng: "en",
    resources: { en: { translation: { connectors: en } } },
    interpolation: { escapeValue: false },
  });
  for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(
      connectorErrorText(i18next.t, "approval", "gmail", code),
      en.approval.errors.generic,
      code
    );
  }
});
