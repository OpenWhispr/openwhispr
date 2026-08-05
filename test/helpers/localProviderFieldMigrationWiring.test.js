const test = require("node:test");
const assert = require("node:assert/strict");
const { registerHooks } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

// The migration's own logic is covered by localProviderFieldMigration.test.js
// against a hand-built storage object. That test stays green even if the call
// at module scope in settingsStore.ts is deleted, so it proves nothing about
// the wiring: whether the migration actually runs, against the real
// localStorage, before create() reads the keys.
//
// settingsStore.ts is renderer code written for Vite, so its imports are
// extensionless and its JSON imports carry no attributes. Node's ESM resolver
// needs both filled in before it will load the module graph.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolveRelative = (relative) => {
      const parent = context.parentURL ? fileURLToPath(context.parentURL) : __filename;
      return path.resolve(path.dirname(parent), relative);
    };
    const asJson = (absolute) => ({
      url: pathToFileURL(absolute).href,
      shortCircuit: true,
      importAttributes: { type: "json" },
    });

    if (specifier.startsWith(".") && specifier.endsWith(".json")) {
      return asJson(resolveRelative(specifier));
    }

    if (specifier.startsWith(".") && !path.extname(specifier)) {
      const base = resolveRelative(specifier);
      const candidates = [".ts", ".tsx", ".js", ".jsx", ".json"]
        .map((ext) => base + ext)
        .concat([".ts", ".tsx", ".js", ".jsx"].map((ext) => path.join(base, `index${ext}`)));
      const hit = candidates.find((candidate) => fs.existsSync(candidate));
      if (hit) {
        return hit.endsWith(".json")
          ? asJson(hit)
          : { url: pathToFileURL(hit).href, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});

function installBrowserGlobals(initial) {
  const data = { ...initial };
  global.localStorage = {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
  global.window = {
    localStorage: global.localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  return data;
}

test("a corrupted provider is already repaired by the time the store reads it", async () => {
  installBrowserGlobals({
    cleanupProvider: "gemma",
    noteFormattingProvider: "qwen",
  });

  const { useSettingsStore, selectResolvedLLMConfig } =
    await import("../../src/stores/settingsStore.ts");
  const state = useSettingsStore.getState();

  assert.equal(
    selectResolvedLLMConfig(state, "dictationCleanup").provider,
    "local",
    "the migration must run at module scope, before create() reads localStorage"
  );
  assert.equal(selectResolvedLLMConfig(state, "noteFormatting").provider, "local");
});
