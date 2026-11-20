// FEAT-05 regression contract: in a fork build, connector and assistant-capability copy
// sends people to their Titanium account and license, never to an OpenWhispr sign-in,
// an OpenWhispr plan, an Upgrade flow, or a settings section a fork build hides.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LOCALES_DIR = path.join(__dirname, "..", "..", "src", "locales");
const LOCALES = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Wording that points at the hosted OpenWhispr cloud account or plan.
const FORBIDDEN = [
  /sign in to (open ?whispr|\{\{brand\}\})\b/i,
  /open ?whispr (account|plan|cloud)/i,
  /plans? (&|and) billing/i,
  /paid plans?/i,
  /\bupgrade\b/i,
];

// Keys whose copy may keep a forbidden term for a reason that is not sign-in or plan
// wording. Each needs a one-line reason.
const ALLOWED_KEYS = new Map([
  // (none today: every connector string is Titanium wording)
]);

function flatten(node, prefix = "") {
  if (typeof node === "string") return [[prefix, node]];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    flatten(value, prefix ? `${prefix}.${key}` : key)
  );
}

for (const locale of LOCALES) {
  test(`${locale}: connector copy names no OpenWhispr sign-in, plan or upgrade`, () => {
    const translation = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, locale, "translation.json"), "utf8")
    );
    const offenders = flatten(translation.connectors, "connectors")
      .filter(([key]) => !ALLOWED_KEYS.has(key))
      .filter(([, value]) => FORBIDDEN.some((pattern) => pattern.test(value)))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(offenders, []);
  });
}

test("fork capability text names the Titanium account or license and a visible section", async () => {
  const { resolveUnavailableCapabilities, describeUnavailable } =
    await import("../../src/config/agentCapabilities.ts");
  const { CLOUD_ONLY_SECTIONS } = await import("../../src/config/cloudSections.ts");
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en", "translation.json"), "utf8"));
  const titaniumSection = "Settings → Titanium account";
  const locations = {
    account: titaniumSection,
    plans: titaniumSection,
    calendars: "Integrations → Calendars",
    connectors: "Integrations → Connectors",
    models: "Settings → AI Models",
  };
  const base = {
    supportsTools: true,
    isSignedIn: false,
    titanium: { brand: "EdgeAssistant" },
    webSearch: { allowed: false, blockedByOrg: false },
    calendarConnected: true,
    locations,
  };
  const connectors = (overrides) => ({
    hasPlan: true,
    allowed: true,
    blockedByOrg: false,
    statuses: {},
    ...overrides,
  });
  const cases = [
    connectors({ signedIn: false }),
    connectors({ signedIn: true, reauthRequired: true }),
    connectors({ signedIn: true, hasPlan: false }),
  ];
  const texts = cases.map((c) =>
    describeUnavailable(resolveUnavailableCapabilities({ ...base, connectors: c }))
  );
  assert.match(texts[0], /sign in with their Titanium account in Settings → Titanium account/);
  assert.match(texts[1], /sign in to their Titanium account again in Settings → Titanium account/);
  assert.match(texts[2], /needs an active EdgeAssistant license in Settings → Titanium account/);
  for (const text of texts) {
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern);
    for (const section of CLOUD_ONLY_SECTIONS) {
      const label = en.settingsModal.sections[section].label;
      assert.ok(!text.includes(`→ ${label}`), `names hidden section ${section} (${label})`);
    }
  }
  // Every reason the fork can produce, including the shared ones, avoids the cloud wording.
  for (const reason of [
    "policyOff",
    "policyLoading",
    "notConnected",
    "needsReconnect",
    "modelTooSmall",
  ]) {
    const text = describeUnavailable([{ name: "X", reason, where: "Y", titanium: { brand: "B" } }]);
    for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, reason);
  }
});
