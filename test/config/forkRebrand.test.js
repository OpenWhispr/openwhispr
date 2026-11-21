// EdgeAssistant rebrand: the display name changes, the install identity does not, so an
// installed build updates in place and keeps its settings, models and secure keys.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const i18next = require("i18next");

const ROOT = path.join(__dirname, "..", "..");
const fork = require("../../src/config/fork.config.json");
const builder = require("../../electron-builder.fork.json");

test("display name is EdgeAssistant across build config and runtime config", () => {
  assert.equal(fork.BRAND_NAME, "EdgeAssistant");
  assert.equal(builder.productName, "EdgeAssistant");
  assert.equal(builder.executableName, "edgeassistant");
  assert.equal(builder.nsis.shortcutName, "EdgeAssistant");
  assert.equal(builder.nsis.uninstallDisplayName, "EdgeAssistant");
  assert.equal(builder.nsis.artifactName, "EdgeAssistant-Setup-${version}.${ext}");
});

test("install identity is unchanged so the installed build updates in place", () => {
  assert.equal(fork.APP_ID, "com.titaniumlabs.titaniumwhisper");
  assert.equal(builder.appId, fork.APP_ID);
  assert.equal(fork.WINDOWS_TRAY_GUID, "580c76fe-f810-4c10-97bd-380060508a21");
  assert.equal(fork.USER_DATA_DIR, "Titanium Whisper");
  assert.deepEqual(builder.protocols.schemes, ["titaniumwhisper"]);
  assert.equal(builder.publish.provider, "github");
  assert.equal(builder.publish.owner, "finedesignz");
  assert.equal(builder.publish.repo, "edgeassistant");
});

test("main.js pins userData to USER_DATA_DIR, not to the product name", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.match(main, /path\.join\(app\.getPath\("appData"\), FORK_IDENTITY\.USER_DATA_DIR\)/);
  assert.match(main, /app\.setPath\("userData", userDataPath\)/);
  assert.doesNotMatch(main, /getPath\("appData"\), FORK_IDENTITY\.BRAND_NAME/);
});

test("locale strings render the product name through {{brand}}", async () => {
  const en = require("../../src/locales/en/translation.json");
  const instance = i18next.createInstance();
  await instance.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false, defaultVariables: { brand: fork.BRAND_NAME } },
  });
  assert.equal(instance.t("tray.tooltip"), "EdgeAssistant - Voice Dictation");
  assert.doesNotMatch(instance.t("tray.tooltip"), /OpenWhispr|Titanium Whisper/);
});

test("renderer entry title and brand-bearing app icon use the new name", () => {
  const html = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");
  assert.match(html, /<title>EdgeAssistant<\/title>/);
});

test("audioManager default agent-name fallback uses the fork brand, not a literal", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "helpers", "audioManager.js"), "utf8");
  assert.match(src, /import \{ BRAND_NAME \} from "\.\.\/config\/forkRuntime"/);
  assert.match(src, /getAgentName\(\) : BRAND_NAME;/);
  assert.doesNotMatch(src, /getAgentName\(\) : "OpenWhispr"/);
});

test("agentName default is the fork brand; stored names are never rewritten", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "utils", "agentName.ts"), "utf8");
  assert.match(src, /import \{ BRAND_NAME \} from "\.\.\/config\/forkRuntime"/);
  assert.match(src, /const DEFAULT_AGENT_NAME = BRAND_NAME;/);
  assert.doesNotMatch(src, /DEFAULT_AGENT_NAME = "OpenWhispr"/);
  // Only the unset fallback and the empty-save fallback use the default; a stored value wins.
  assert.match(src, /localStorage\.getItem\(AGENT_NAME_KEY\) \|\| DEFAULT_AGENT_NAME/);
  assert.doesNotMatch(src, /===\s*DEFAULT_AGENT_NAME|DEFAULT_AGENT_NAME\s*===/);
});
