// Shared setup for tests that load renderer modules through Vite SSR:
// Map-backed browser globals plus a dev server with per-test module mocks.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function installBrowserGlobals(t, { initialStorage = {}, window: windowProps = {} } = {}) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map(Object.entries(initialStorage));
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  globalThis.localStorage = storage;
  globalThis.window = {
    innerWidth: 1200,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setInterval() {
      return 1;
    },
    electronAPI: {},
    ...windowProps,
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  });
  return { window: globalThis.window, storage };
}

// mockModules maps an import-path suffix (e.g. "/utils/logger") to the ESM
// source served in its place.
async function createRendererServer(
  t,
  { cachePrefix = "openwhispr-renderer-test-", mockModules = {}, noExternal = false } = {}
) {
  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  const suffixes = Object.keys(mockModules);
  const voiceSurfaceGeometryPath = path.resolve(
    __dirname,
    "../../src/helpers/voiceSurfaceGeometry.js"
  );
  const voiceSurfaceGeometryModuleId = "\0commonjs:voiceSurfaceGeometry";
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    ssr: noExternal ? { noExternal: true } : undefined,
    plugins: [
      {
        name: "renderer-test-module-mocks",
        enforce: "pre",
        resolveId(source) {
          const suffix = suffixes.find((candidate) => source.endsWith(candidate));
          if (suffix) return `\0mock:${suffix}`;
          if (source.endsWith("/voiceSurfaceGeometry")) {
            return voiceSurfaceGeometryModuleId;
          }
          return null;
        },
        load(id) {
          if (id === voiceSurfaceGeometryModuleId) {
            return `
              import { createRequire } from "node:module";
              const require = createRequire(import.meta.url);
              const geometry = require(${JSON.stringify(voiceSurfaceGeometryPath)});
              export const ASSISTANT_PANEL_SIZE_LIMITS = geometry.ASSISTANT_PANEL_SIZE_LIMITS;
              export const LIVE_TRANSCRIPT_SURFACE_LIMITS = geometry.LIVE_TRANSCRIPT_SURFACE_LIMITS;
            `;
          }
          if (!id.startsWith("\0mock:")) return null;
          return mockModules[id.slice("\0mock:".length)];
        },
      },
    ],
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
  return vite;
}

module.exports = { createRendererServer, installBrowserGlobals };
