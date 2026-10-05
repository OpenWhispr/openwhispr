const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/i18nDocument.ts");

function createI18n(language) {
  const listeners = new Set();
  return {
    language,
    resolvedLanguage: language,
    dir: (value) => (value.toLowerCase().startsWith("ar") ? "rtl" : "ltr"),
    on(event, listener) {
      assert.equal(event, "languageChanged");
      listeners.add(listener);
    },
    off(event, listener) {
      assert.equal(event, "languageChanged");
      listeners.delete(listener);
    },
    emit(nextLanguage) {
      this.language = nextLanguage;
      this.resolvedLanguage = nextLanguage;
      for (const listener of listeners) listener(nextLanguage);
    },
    listenerCount: () => listeners.size,
  };
}

test("document language binding initializes and updates both lang and dir", async () => {
  const { bindDocumentLanguage } = await load();
  const i18n = createI18n("ar");
  const root = { lang: "", dir: "" };

  const dispose = bindDocumentLanguage(i18n, root);
  assert.deepEqual(root, { lang: "ar", dir: "rtl" });

  i18n.emit("en-US");
  assert.deepEqual(root, { lang: "en-US", dir: "ltr" });

  dispose();
  assert.equal(i18n.listenerCount(), 0);
});

test("HMR disposal removes the exact language listener and remains idempotent", async () => {
  const { bindDocumentLanguage } = await load();
  const i18n = createI18n("en");
  const root = { lang: "", dir: "" };
  let hotDispose;
  const hot = {
    dispose(callback) {
      hotDispose = callback;
    },
  };

  const dispose = bindDocumentLanguage(i18n, root, hot);
  assert.equal(i18n.listenerCount(), 1);
  assert.equal(typeof hotDispose, "function");

  hotDispose();
  dispose();
  assert.equal(i18n.listenerCount(), 0);
  i18n.emit("ar");
  assert.deepEqual(root, { lang: "en", dir: "ltr" });
});
