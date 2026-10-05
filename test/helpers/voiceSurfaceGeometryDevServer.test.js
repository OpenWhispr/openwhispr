const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

const SRC_ROOT = path.resolve(__dirname, "../../src");

test("the Vite dev module graph exposes the shared renderer geometry exports", async (t) => {
  if (typeof vm.SourceTextModule !== "function") {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-vm-modules", __filename],
      {
        encoding: "utf8",
        env: childEnv,
      }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return;
  }

  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-vite-geometry-test-"));
  const vite = await createServer({
    root: SRC_ROOT,
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const modules = new Map();

  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const loadModule = async (moduleId) => {
    if (modules.has(moduleId)) return modules.get(moduleId);

    const transformed = await vite.transformRequest(moduleId);
    assert.ok(transformed, `Vite did not transform ${moduleId}`);
    const module = new vm.SourceTextModule(transformed.code, {
      identifier: moduleId,
      initializeImportMeta(meta) {
        meta.url = `http://localhost${moduleId}`;
      },
    });
    modules.set(moduleId, module);
    await module.link(async (specifier, referencingModule) => {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const moduleUrl = new URL(specifier, `http://localhost${referencingModule.identifier}`);
        return loadModule(`${moduleUrl.pathname}${moduleUrl.search}`);
      }
      const resolved = await vite.pluginContainer.resolveId(
        specifier,
        referencingModule.identifier
      );
      assert.ok(resolved, `Vite did not resolve ${specifier}`);
      return loadModule(resolved.id);
    });
    return module;
  };

  const presentation = await loadModule("/helpers/voicePillPresentation.js");

  assert.equal(presentation.status, "linked");
});
