const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modelRegistry = require("../../src/models/modelRegistryData.json");

const SRC = path.join(__dirname, "../../src");
const LOCALES = path.join(SRC, "locales");
const NAMESPACES = ["translation", "prompts"];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const T_CALL = /\bt\(\s*(['"`])([A-Za-z0-9_.-]+)\1/g;
const INTERPOLATION = /\{\{\s*([\w.]+)/g;
const ARABIC_PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
const ARABIC_PLURAL_BASES = [
  "settingsPage.workspace.members.description",
  "settingsPage.workspace.teams.memberCount",
  "settingsPage.workspace.teams.grantsAccessToSpaces",
  "settingsPage.workspace.teams.deleteConfirmSpaceAccess",
  "settingsPage.workspace.invites.expiresIn",
  "settingsPage.unifiedBilling.seatUpdated",
  "settingsPage.unifiedBilling.confirmSeats.description",
  "settingsPage.privacy.retentionDays",
  "settingsPage.privacy.audioStorageFiles",
  "settingsPage.privacy.hoursAgo",
  "settingsPage.privacy.minutesAgo",
  "settingsPage.enterpriseCheckout.seatsHint",
  "workspaces.join.memberCount",
  "notes.spaces.noteCount",
  "notes.spaces.invitedTo",
  "notes.spaces.teamsMembers.affectsOtherSpaces",
  "notes.addToFolder.addCount",
  "notes.overview.meta.folders",
  "notes.overview.meta.members",
  "dictionary.wordsReady",
];
const ARABIC_NUMBER_NEUTRAL_TEMPLATES = {
  "workspaces.invite.seatUsage": "المقاعد المستخدمة: {{used}} من أصل {{seats}}",
  "notes.spaces.members.addFailed": "عدد الأشخاص الذين تعذرت إضافتهم: {{failed}} من أصل {{total}}",
  "notes.upload.partialWarningCount":
    "عدد الأجزاء الصوتية التي تعذر نسخها: {{failed}} من أصل {{total}}.",
  "settingsPage.account.planDescriptions.trial":
    "عدد الأيام المتبقية: {{days}} - نسخ نصية غير محدودة",
  "emailVerification.resendIn": "إعادة الإرسال بعد {{seconds}} ث",
  "meetingNotification.autoEnd.body.micReleased":
    "لا يستخدم أي تطبيق آخر ميكروفونك، لذا توقف التسجيل تلقائيًا. أعد تشغيل التسجيل خلال {{seconds}} ث.",
  "meetingNotification.autoEnd.body.silence":
    "لم يُكتشف أي صوت، لذا توقف التسجيل تلقائيًا. أعد تشغيل التسجيل خلال {{seconds}} ث.",
  "meetingNotification.autoEnd.body.processExit":
    "أُغلق تطبيق الاجتماع، لذا توقف التسجيل تلقائيًا. أعد تشغيل التسجيل خلال {{seconds}} ث.",
};

const languages = fs
  .readdirSync(LOCALES)
  .filter((entry) => fs.statSync(path.join(LOCALES, entry)).isDirectory());

const load = (lang, namespace) =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, lang, `${namespace}.json`), "utf8"));

function flatten(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, value);
  }
  return out;
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "locales" && entry.name !== "dist") sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const stripPlural = (key) => key.replace(PLURAL_SUFFIX, "");

function registryDescriptionKeys(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) registryDescriptionKeys(child, out);
  } else if (node && typeof node === "object") {
    if (typeof node.descriptionKey === "string") out.push(node.descriptionKey);
    for (const child of Object.values(node)) registryDescriptionKeys(child, out);
  }
  return out;
}

test("every t() key referenced in source resolves in en", () => {
  const keys = new Set();
  for (const namespace of NAMESPACES) {
    for (const key of flatten(load("en", namespace)).keys()) keys.add(key);
  }
  // i18next also resolves a plural base and a parent path returned as an object.
  const bases = new Set([...keys].map(stripPlural));
  const parents = new Set();
  for (const key of keys) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i += 1) parents.add(parts.slice(0, i).join("."));
  }

  const broken = [];
  for (const file of sourceFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(T_CALL)) {
      const key = match[2];
      if (!key.includes(".")) continue;
      if (keys.has(key) || bases.has(key) || parents.has(key)) continue;
      broken.push(
        `${path.relative(SRC, file)}:${source.slice(0, match.index).split("\n").length} → ${key}`
      );
    }
  }

  assert.deepEqual(broken, [], `Missing en translations:\n${broken.join("\n")}`);
});

// Model descriptions are data-driven (t(descriptionKey, { defaultValue })), so
// the source scan above can't see them and a missing key silently falls back
// to English. Other locales are covered by the en-parity test below.
test("every model registry descriptionKey resolves in en", () => {
  const en = flatten(load("en", "translation"));
  const keys = registryDescriptionKeys(modelRegistry);
  assert.ok(keys.length > 0, "no descriptionKey found in the model registry");

  const broken = keys.filter((key) => typeof en.get(key) !== "string" || en.get(key) === "");
  assert.deepEqual(broken, [], `Registry descriptionKeys missing in en:\n${broken.join("\n")}`);
});

test("every en key is present in every other language", () => {
  for (const namespace of NAMESPACES) {
    const en = flatten(load("en", namespace));
    for (const lang of languages) {
      if (lang === "en") continue;
      const translated = flatten(load(lang, namespace));
      // Plural categories are language specific (ru adds _few/_many, zh only has
      // _other), so a matching plural base counts as covered.
      const bases = new Set([...translated.keys()].map(stripPlural));
      const gaps = [...en.keys()].filter(
        (key) => !translated.has(key) && !bases.has(stripPlural(key))
      );
      assert.deepEqual(gaps, [], `${lang}/${namespace} is missing:\n${gaps.join("\n")}`);
    }
  }
});

test("interpolation variables match en in every language", () => {
  // Compares names, not repeat counts — word order can make a translation
  // reference the same variable a different number of times.
  const variables = (value) =>
    typeof value === "string"
      ? [...new Set([...value.matchAll(INTERPOLATION)].map((m) => m[1]))].sort()
      : [];

  for (const namespace of NAMESPACES) {
    const en = flatten(load("en", namespace));
    for (const lang of languages) {
      if (lang === "en") continue;
      for (const [key, value] of flatten(load(lang, namespace))) {
        if (!en.has(key)) continue;
        assert.deepEqual(
          variables(value),
          variables(en.get(key)),
          `${lang}/${namespace} ${key} has different {{variables}} than en`
        );
      }
    }
  }
});

test("Arabic defines every CLDR plural category for each counted message", () => {
  const ar = flatten(load("ar", "translation"));
  for (const base of ARABIC_PLURAL_BASES) {
    for (const category of ARABIC_PLURAL_CATEGORIES) {
      assert.equal(
        typeof ar.get(`${base}_${category}`),
        "string",
        `ar/translation is missing ${base}_${category}`
      );
    }
  }
});

test("Arabic non-count numeric templates remain number-neutral", () => {
  const ar = flatten(load("ar", "translation"));
  for (const [key, template] of Object.entries(ARABIC_NUMBER_NEUTRAL_TEMPLATES)) {
    assert.equal(ar.get(key), template, `${key} reintroduced a fixed Arabic number form`);
  }
});

test("Arabic plural counts resolve the exact CLDR form without English fallback", async () => {
  const i18next = require("i18next");
  const instance = i18next.createInstance();
  await instance.init({
    lng: "ar",
    fallbackLng: "en",
    resources: {
      ar: { translation: load("ar", "translation") },
      en: { translation: load("en", "translation") },
    },
    interpolation: { escapeValue: false },
  });

  const counts = [0, 1, 2, 3, 7, 11, 100, 101];
  const pluralRules = new Intl.PluralRules("ar");
  for (const base of ARABIC_PLURAL_BASES) {
    for (const count of counts) {
      const details = instance.t(base, { count, returnDetails: true });
      const category = pluralRules.select(count);
      assert.equal(details.usedLng, "ar", `${base} count=${count} used ${details.usedLng}`);
      assert.equal(
        details.exactUsedKey,
        `${base}_${category}`,
        `${base} count=${count} did not use the Arabic ${category} form`
      );
    }
  }
});
