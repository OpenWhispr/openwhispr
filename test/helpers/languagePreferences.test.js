const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/languagePreferences.js");

test("normalizePreferredLanguages drops auto, blanks, non-strings and dupes, then caps", async () => {
  const { normalizePreferredLanguages, MAX_PREFERRED_LANGUAGES } = await load();

  assert.deepEqual(normalizePreferredLanguages(["en", "auto", "pl", "en", "", null, 7]), [
    "en",
    "pl",
  ]);
  assert.deepEqual(
    normalizePreferredLanguages(["en", "pl", "de", "fr", "es", "it"]),
    ["en", "pl", "de", "fr", "es"].slice(0, MAX_PREFERRED_LANGUAGES)
  );
  assert.deepEqual(normalizePreferredLanguages("not-an-array"), []);
});

test("choosing auto as active language clears the multi-select set", async () => {
  const { resolveActiveLanguageChange } = await load();

  assert.deepEqual(
    resolveActiveLanguageChange(
      { preferredLanguage: "en", preferredLanguages: ["en", "pl"] },
      "auto"
    ),
    { preferredLanguage: "auto", preferredLanguages: [] }
  );
});

test("choosing auto with an already-empty set keeps the same array reference", async () => {
  const { resolveActiveLanguageChange } = await load();

  const empty = [];
  const next = resolveActiveLanguageChange(
    { preferredLanguage: "en", preferredLanguages: empty },
    "auto"
  );
  assert.equal(next.preferredLanguages, empty);
});

test("activating a language missing from a non-empty set inserts it", async () => {
  const { resolveActiveLanguageChange } = await load();

  assert.deepEqual(
    resolveActiveLanguageChange(
      { preferredLanguage: "en", preferredLanguages: ["en", "pl"] },
      "de"
    ),
    { preferredLanguage: "de", preferredLanguages: ["en", "pl", "de"] }
  );
});

test("activating a language when the set is full keeps the active language in the set", async () => {
  const { resolveActiveLanguageChange } = await load();

  const next = resolveActiveLanguageChange(
    { preferredLanguage: "en", preferredLanguages: ["en", "pl", "de", "fr", "es"] },
    "it"
  );
  assert.equal(next.preferredLanguage, "it");
  assert.ok(next.preferredLanguages.includes("it"));
  assert.equal(next.preferredLanguages.length, 5);
});

test("activating a language already in the set leaves the set untouched (same reference)", async () => {
  const { resolveActiveLanguageChange } = await load();

  const languages = ["en", "pl"];
  const next = resolveActiveLanguageChange(
    { preferredLanguage: "en", preferredLanguages: languages },
    "pl"
  );
  assert.deepEqual(next, { preferredLanguage: "pl", preferredLanguages: languages });
  assert.equal(next.preferredLanguages, languages);
});

test("replacing the set keeps the active language when it is still present", async () => {
  const { resolveLanguageSetChange } = await load();

  assert.deepEqual(resolveLanguageSetChange({ preferredLanguage: "pl" }, ["en", "pl", "de"]), {
    preferredLanguage: "pl",
    preferredLanguages: ["en", "pl", "de"],
  });
});

test("replacing the set moves the active language to the first preset when evicted", async () => {
  const { resolveLanguageSetChange } = await load();

  assert.deepEqual(resolveLanguageSetChange({ preferredLanguage: "pl" }, ["en", "de"]), {
    preferredLanguage: "en",
    preferredLanguages: ["en", "de"],
  });
});

test("clearing the set keeps the active language (single-language mode)", async () => {
  const { resolveLanguageSetChange } = await load();

  assert.deepEqual(resolveLanguageSetChange({ preferredLanguage: "pl" }, []), {
    preferredLanguage: "pl",
    preferredLanguages: [],
  });
});

test("legacy stored values are repaired at load: auto stripped, active kept valid", async () => {
  const { resolveLanguageSetChange } = await load();

  // Pre-rule persistence could contain "auto" inside the set and an active
  // language that the sanitized set no longer offers.
  assert.deepEqual(resolveLanguageSetChange({ preferredLanguage: "auto" }, ["auto", "en", "pl"]), {
    preferredLanguage: "en",
    preferredLanguages: ["en", "pl"],
  });
});

test("selecting auto in the multi-select engages exclusive auto detect", async () => {
  const { resolveLanguageSelection } = await load();

  assert.deepEqual(resolveLanguageSelection(["en", "pl"], ["en", "pl", "auto"]), {
    preferredLanguage: "auto",
  });
});

test("selecting languages in the multi-select updates the set with auto filtered out", async () => {
  const { resolveLanguageSelection } = await load();

  assert.deepEqual(resolveLanguageSelection(["en"], ["en", "pl"]), {
    preferredLanguages: ["en", "pl"],
  });
  // When auto is already the current mode, picking a language replaces it.
  assert.deepEqual(resolveLanguageSelection(["auto"], ["auto", "en"]), {
    preferredLanguages: ["en"],
  });
});
