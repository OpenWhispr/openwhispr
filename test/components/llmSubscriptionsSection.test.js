const test = require("node:test");
const assert = require("node:assert/strict");

const view = require("../../src/helpers/llmCli/llmCliSeatView.js");
const providers = require("../../src/helpers/llmCliProviders.js");

const NOT_ENABLED = { claudeEnabled: false };
const ENABLED = { claudeEnabled: true };

function actionsFor(seat, state, prefs = NOT_ENABLED, platform = "win32") {
  return view.seatViewModel(seat, state, prefs, platform).actions;
}

test("codex: actions per state", () => {
  assert.deepEqual(actionsFor("codex", { status: "missing" }), ["install", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "outdated", version: "0.1.0" }), ["redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "installed", authKnown: false }), [
    "signin",
    "test",
    "redetect",
  ]);
  assert.deepEqual(actionsFor("codex", { status: "signed-out" }), ["signin", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "signed-in" }), ["test", "signout", "redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "error", errorCode: "timeout" }), ["redetect"]);
  assert.deepEqual(actionsFor("codex", { status: "installing" }), ["cancelInstall"]);
  assert.deepEqual(actionsFor("codex", { status: "signing-in" }), ["cancelSignin"]);
});

test("codex: classified error maps to a known key, unknown code falls to generic", () => {
  const known = view.seatViewModel("codex", { status: "error", errorCode: "timeout" }, NOT_ENABLED);
  assert.equal(known.errorKey, "llmSubscriptions.errors.timeout");
  const unknown = view.seatViewModel(
    "codex",
    { status: "error", errorCode: "weird-vendor-text" },
    NOT_ENABLED
  );
  assert.equal(unknown.errorKey, "llmSubscriptions.errors.generic");
  const none = view.seatViewModel("codex", { status: "error" }, NOT_ENABLED);
  assert.equal(none.errorKey, "llmSubscriptions.errors.generic");
  assert.equal(
    view.seatViewModel("codex", { status: "signed-in" }, NOT_ENABLED).errorKey,
    null,
    "no error key when nothing failed"
  );
  assert.equal(view.errorMessageKey("not-signed-in"), "llmSubscriptions.errors.not-signed-in");
});

test("every classified error code has a message key", () => {
  for (const code of providers.ERROR_CODES) {
    assert.equal(view.errorMessageKey(code), `llmSubscriptions.errors.${code}`);
  }
});

test("an unrecognised status shows as missing, a missing state too", () => {
  assert.equal(view.seatViewModel("codex", { status: "bogus" }, NOT_ENABLED).status, "missing");
  assert.equal(view.seatViewModel("codex", undefined, NOT_ENABLED).status, "missing");
});

test("outdated seat carries the update hint and the version", () => {
  const vm = view.seatViewModel("codex", { status: "outdated", version: "0.1.0" }, NOT_ENABLED);
  assert.equal(vm.hintKey, "llmSubscriptions.outdatedHint");
  assert.equal(vm.version, "0.1.0");
});

test("unknown seat throws", () => {
  assert.throws(() => view.seatViewModel("gemini", { status: "missing" }, NOT_ENABLED));
});

test("missing: Install for script seats, Open guide for grok, never both", () => {
  for (const seat of ["codex", "claude", "agy"]) {
    const a = actionsFor(seat, { status: "missing" }, ENABLED);
    assert.ok(a.includes("install"), seat);
    assert.ok(!a.includes("openGuide"), seat);
  }
  const grok = actionsFor("grok", { status: "missing" });
  assert.ok(grok.includes("openGuide"));
  assert.ok(!grok.includes("install"));
});

test("posix platforms read the posix install spec but keep the same actions", () => {
  assert.ok(actionsFor("codex", { status: "missing" }, NOT_ENABLED, "linux").includes("install"));
});

test("installed with authKnown false (agy, grok) offers Sign in and Test", () => {
  for (const seat of ["agy", "grok"]) {
    const a = actionsFor(seat, { status: "installed", authKnown: false });
    assert.ok(a.includes("signin") && a.includes("test"), seat);
  }
});

test("install dialog carries the exact table url and command, and confirm returns that url", () => {
  for (const [seat, platform] of [
    ["codex", "win32"],
    ["codex", "linux"],
    ["claude", "win32"],
    ["agy", "darwin"],
  ]) {
    const model = view.installDialogModel(seat, platform);
    const spec = providers.installSpec(seat, platform);
    const argv = providers.installCommand(seat, platform);
    assert.equal(model.kind, "script");
    assert.equal(model.url, spec.url);
    assert.equal(model.confirmUrl, spec.url, "the confirm action returns the table url unchanged");
    assert.equal(model.command, argv[argv.length - 1]);
    assert.ok(model.command.includes(spec.url), "the printed command contains the url");
  }
});

test("grok has a guided install model with the official link and no confirm url", () => {
  const model = view.installDialogModel("grok", "win32");
  assert.equal(model.kind, "guided");
  assert.equal(model.url, providers.installSpec("grok", "win32").url);
  assert.equal(model.confirmUrl, null);
});

test("claude row is disabled while off, shows a toggle, and the notice only after enabling", () => {
  const off = view.seatViewModel("claude", { status: "installed" }, NOT_ENABLED);
  assert.equal(off.disabled, true);
  assert.equal(off.showToggle, true);
  assert.equal(off.claudeEnabled, false);
  assert.equal(off.noticeKey, null);
  assert.deepEqual(off.actions, []);

  const missingPrefs = view.seatViewModel("claude", { status: "installed" }, undefined);
  assert.equal(missingPrefs.disabled, true, "no prefs means off");

  const on = view.seatViewModel("claude", { status: "signed-in" }, ENABLED);
  assert.equal(on.disabled, false);
  assert.equal(on.noticeKey, "llmSubscriptions.claude.notice");
  assert.deepEqual(on.actions, ["test", "signout", "redetect"]);
});

test("the other three rows never show the toggle or the Claude notice", () => {
  for (const seat of ["codex", "grok", "agy"]) {
    for (const prefs of [NOT_ENABLED, ENABLED]) {
      const vm = view.seatViewModel(seat, { status: "signed-in" }, prefs);
      assert.equal(vm.showToggle, false, seat);
      assert.equal(vm.noticeKey, null, seat);
      assert.equal(vm.disabled, false, seat);
    }
  }
});

test("device sign-in prompts show url and code; open-in-browser needs an allowlisted host", () => {
  const ok = view.signInPromptModel("codex", {
    type: "signin-prompt",
    seat: "codex",
    kind: "device-code",
    url: "https://auth.openai.com/codex/device",
    code: "ABCD-EFGH",
  });
  assert.equal(ok.kind, "device-code");
  assert.equal(ok.code, "ABCD-EFGH");
  assert.equal(ok.canOpenUrl, true);
  assert.equal(ok.showCodeInput, false);

  const grok = view.signInPromptModel("grok", {
    seat: "grok",
    kind: "device-code",
    url: "https://accounts.x.ai/device",
    code: "WXYZ",
  });
  assert.equal(grok.canOpenUrl, true);

  for (const url of [
    "https://auth.openai.com.evil.example/device",
    "http://auth.openai.com/device",
    "https://xn--auth-openai-9ya.com/device",
    "javascript:alert(1)",
    "https://user@auth.openai.com/device",
  ]) {
    const bad = view.signInPromptModel("codex", {
      seat: "codex",
      kind: "device-code",
      url,
      code: "X",
    });
    assert.equal(bad.canOpenUrl, false, url);
  }
  assert.equal(
    view.signInPromptModel("grok", {
      seat: "grok",
      kind: "device-code",
      url: "https://auth.openai.com/x",
    }).canOpenUrl,
    false,
    "a host allowed for another seat is not allowed here"
  );
});

test("claude sign-in shows a code box; agy shows the guide; foreign events are ignored", () => {
  const claude = view.signInPromptModel("claude", {
    seat: "claude",
    kind: "browser",
    url: "https://claude.ai/oauth/authorize?x=1",
    awaitingCode: true,
  });
  assert.equal(claude.kind, "claude-code");
  assert.equal(claude.showCodeInput, true);
  assert.equal(claude.canOpenUrl, true);

  const agy = view.signInPromptModel("agy", { seat: "agy", kind: "terminal-guide" });
  assert.equal(agy.kind, "guide");
  assert.equal(agy.guideKey, "llmSubscriptions.signIn.agyGuide");
  assert.equal(agy.canOpenUrl, false);

  assert.equal(view.signInPromptModel("codex", { seat: "claude", kind: "browser" }), null);
  assert.equal(view.signInPromptModel("codex", undefined), null);
});

test("sign out: codex and grok confirm and say the terminal CLI is signed out too", () => {
  for (const seat of ["codex", "grok"]) {
    const m = view.signOutConfirmModel(seat);
    assert.equal(m.required, true, seat);
    assert.equal(m.affectsTerminalCli, true, seat);
    assert.equal(m.messageKey, "llmSubscriptions.signOut.terminalCli", seat);
  }
});

test("sign out: claude confirms with the token-stays-valid text; agy is a guide only", () => {
  const claude = view.signOutConfirmModel("claude");
  assert.equal(claude.required, true);
  assert.equal(claude.affectsTerminalCli, false);
  assert.equal(claude.messageKey, "llmSubscriptions.signOut.claudeToken");
  const agy = view.signOutConfirmModel("agy");
  assert.equal(agy.required, false);
  assert.equal(agy.guide, true);
});

// ---- Hard-rule sweep (D-05, LLM-08, LLM-09) ----

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../..");
const LOCALES = ["ar", "de", "en", "es", "fr", "it", "ja", "pt", "ru", "zh-CN", "zh-TW"];

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function leafKeys(value, prefix = "") {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key)
  );
}

function localeDoc(locale) {
  return JSON.parse(readSource(`src/locales/${locale}/translation.json`));
}

test("all 11 locale files carry the same subscriptions key set as English", () => {
  assert.equal(
    fs.readdirSync(path.join(ROOT, "src/locales")).filter((d) => LOCALES.includes(d)).length,
    11
  );
  const en = localeDoc("en");
  const expected = [
    ...leafKeys(en.llmSubscriptions, "llmSubscriptions"),
    ...leafKeys(en.settingsModal.sections.subscriptions, "settingsModal.sections.subscriptions"),
  ].sort();
  assert.ok(expected.length > 60, "the English key set is populated");
  for (const locale of LOCALES) {
    const doc = localeDoc(locale);
    const actual = [
      ...leafKeys(doc.llmSubscriptions, "llmSubscriptions"),
      ...leafKeys(doc.settingsModal.sections.subscriptions, "settingsModal.sections.subscriptions"),
    ].sort();
    assert.deepEqual(actual, expected, locale);
  }
});

test("no locale leaves a subscriptions string empty, and brand names stay untranslated", () => {
  for (const locale of LOCALES) {
    const doc = localeDoc(locale);
    for (const key of leafKeys(doc.llmSubscriptions)) {
      const value = key.split(".").reduce((o, k) => o[k], doc.llmSubscriptions);
      assert.equal(typeof value, "string", `${locale} ${key}`);
      assert.ok(value.trim().length > 0, `${locale} ${key} is empty`);
    }
    assert.match(doc.llmSubscriptions.seats.claude, /Claude/, locale);
    assert.match(doc.llmSubscriptions.seats.codex, /Codex/, locale);
    assert.match(doc.llmSubscriptions.seats.grok, /Grok/, locale);
    assert.match(doc.llmSubscriptions.seats.agy, /Antigravity/, locale);
  }
});

test("every key the section and view model use exists in English", () => {
  const en = localeDoc("en");
  const has = (key) => key.split(".").reduce((o, k) => (o ? o[k] : undefined), en) !== undefined;
  const sources = [
    "src/components/settings/LlmSubscriptionsSection.tsx",
    "src/components/settings/CliProviderPicker.tsx",
    "src/helpers/llmCli/llmCliSeatView.js",
  ].map(readSource);
  for (const src of sources) {
    for (const match of src.matchAll(/["'`](llmSubscriptions\.[A-Za-z.-]+)["'`]/g)) {
      assert.ok(has(match[1]), `missing key ${match[1]}`);
    }
  }
  for (const seat of ["claude", "codex", "grok", "agy"])
    assert.ok(has(`llmSubscriptions.seats.${seat}`));
  for (const status of [
    "missing",
    "installing",
    "installed",
    "outdated",
    "signing-in",
    "signed-in",
    "signed-out",
    "error",
  ]) {
    assert.ok(has(`llmSubscriptions.status.${status}`), status);
  }
});

test("new TSX files import no lucide-react and no /assets/ literal path", () => {
  for (const rel of [
    "src/components/settings/LlmSubscriptionsSection.tsx",
    "src/components/settings/CliProviderPicker.tsx",
    "src/hooks/useLlmCliProviders.ts",
    "src/services/ai/cliChatModel.ts",
    "src/services/ai/inferenceProviders/cliSubscription.ts",
  ]) {
    const src = readSource(rel);
    assert.doesNotMatch(src, /lucide-react/, rel);
    assert.doesNotMatch(src, /["'`]\/assets\//, rel);
  }
});

test("LLM_POLICY_PROVIDER_IDS is unchanged by this phase (D-05)", () => {
  const src = readSource("src/stores/settingsStore.ts");
  const block = src.match(/export const LLM_POLICY_PROVIDER_IDS = \[([\s\S]*?)\] as const;/);
  assert.ok(block, "LLM_POLICY_PROVIDER_IDS declared");
  assert.equal(
    block[1].replace(/\s+/g, " ").trim(),
    '...modelRegistryData.cloudProviders.map((provider) => provider.id), "openrouter", "custom",'
  );
  const data = require("../../src/models/modelRegistryData.json");
  assert.deepEqual(
    [...data.cloudProviders.map((p) => p.id), "openrouter", "custom"],
    ["openai", "anthropic", "gemini", "groq", "tinfoil", "corti", "openrouter", "custom"]
  );
  assert.doesNotMatch(block[1], /cli/i, "no CLI id in the BYOK policy list");
});

test("BYOK key handling does not mention the CLI seats", () => {
  assert.doesNotMatch(readSource("src/config/secretKeys.js"), /cli-|llmCli/i);
});

test("the Claude token env var is main-only: no renderer source references it", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "locales", "dist"].includes(entry.name)) continue;
        if (full.endsWith(path.join("src", "helpers"))) continue;
        walk(full);
      } else if (
        /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
        /CLAUDE_CODE_OAUTH_TOKEN/.test(fs.readFileSync(full, "utf8"))
      ) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  for (const dir of ["src/components", "src/services", "src/hooks", "src/stores"])
    walk(path.join(ROOT, dir));
  assert.deepEqual(offenders, []);
});
