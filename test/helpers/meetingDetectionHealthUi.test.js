const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(REPO, relative), "utf8");

// This repo has shipped a raw i18n key to users before (meetingHotkey.clear), so
// a new UI surface has to prove every string resolves in every locale.

const LOCALES = fs
  .readdirSync(path.join(REPO, "src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const keyPaths = (value, prefix = "") =>
  typeof value === "object" && value !== null
    ? Object.entries(value).flatMap(([key, child]) =>
        keyPaths(child, prefix ? `${prefix}.${key}` : key)
      )
    : [prefix];

const translations = (locale) =>
  JSON.parse(read(path.join("src/locales", locale, "translation.json")));

test("all ten locales exist", () => {
  assert.equal(LOCALES.length, 10, `expected 10 locales, found ${LOCALES.join(", ")}`);
});

test("every meeting-detection string is defined in every locale", () => {
  const expected = keyPaths(translations("en").settings.meetingDetection).sort();
  assert.ok(expected.length > 0, "the English block must exist");

  for (const locale of LOCALES) {
    const block = translations(locale).settings?.meetingDetection;
    assert.ok(block, `${locale} is missing settings.meetingDetection`);
    assert.deepEqual(keyPaths(block).sort(), expected, `${locale} has a different key set`);
    for (const key of expected) {
      const value = key.split(".").reduce((acc, part) => acc?.[part], block);
      assert.equal(typeof value, "string", `${locale}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test("every status the registry can actually report has a label", () => {
  const { MeetingDetectionHealth } = require("../../src/helpers/meetingDetectionHealth");
  const labels = translations("en").settings.meetingDetection.status;

  const reported = new Set();
  for (const mode of ["event-driven", "polling", "unavailable", "stopped"]) {
    const registry = new MeetingDetectionHealth();
    registry.setMode("audio", mode);
    reported.add(registry.getStatus());
  }

  for (const status of reported) {
    assert.ok(labels[status], `the registry can report "${status}" with no label for it`);
  }
  assert.equal(reported.size, 4, "expected one label per reachable status");
});

test("the interpolated reason keeps its placeholder in every locale", () => {
  for (const locale of LOCALES) {
    assert.match(
      translations(locale).settings.meetingDetection.reason,
      /\{\{reason\}\}/,
      `${locale} dropped the {{reason}} placeholder`
    );
  }
});

test("the health IPC is registered, bridged and typed", () => {
  assert.match(read("src/helpers/ipcHandlers.js"), /ipcMain\.handle\("get-meeting-detection-health"/);
  assert.match(read("preload.js"), /getMeetingDetectionHealth:.*invoke\("get-meeting-detection-health"\)/);
  assert.match(read("src/types/electron.ts"), /getMeetingDetectionHealth: \(\) => Promise</);
});

test("the status row and the notice are actually rendered", () => {
  assert.match(read("src/components/SettingsPage.tsx"), /<MeetingDetectionStatusRow \/>/);
  assert.match(read("src/components/ControlPanel.tsx"), /<MeetingDetectionNotice/);
});

test("the UI only asks for keys that exist", () => {
  const sources = [
    read("src/components/settings/MeetingSettings.tsx"),
    read("src/components/ui/MeetingDetectionNotice.tsx"),
  ].join("\n");

  const referenced = [...sources.matchAll(/t\(\s*"(settings\.meetingDetection[^"]*)"/g)].map(
    (match) => match[1]
  );
  assert.ok(referenced.length > 0, "expected the components to use the new keys");

  const en = translations("en");
  for (const key of referenced) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], en);
    assert.equal(typeof value, "string", `${key} does not resolve to a string`);
  }
});
