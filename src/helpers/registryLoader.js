const fs = require("node:fs/promises");
const path = require("node:path");
const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("../models/registryEnvelope.cjs");
const { validateManifest, acceptCatalog } = require("../models/registrySchema.cjs");

const REGISTRY_URL =
  "https://raw.githubusercontent.com/OpenWhispr/model-registry/published/v2/manifest.json";
// A stolen signing key could otherwise publish the largest possible version once and
// lock every app out of all later corrections.
const MAX_VERSION_STEP = 10000;

async function readBoundedCache(file) {
  const handle = await fs.open(file, "r");
  try {
    if ((await handle.stat()).size > MAX_ENVELOPE_BYTES)
      throw new Error("Registry cache too large");
    const buffer = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ENVELOPE_BYTES) throw new Error("Registry cache too large");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readBoundedResponse(response) {
  if (!response.ok) throw new Error(`Registry HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_ENVELOPE_BYTES)
    throw new Error("Registry response too large");
  if (!response.body) throw new Error("Empty registry response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENVELOPE_BYTES) throw new Error("Registry response too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function createRegistryLoader({
  cachePath,
  bundledSnapshot,
  clientContract,
  trustedKeys,
  appVersion,
  applySnapshot,
  fetch,
  isEnabled = () => process.env.OPENWHISPR_MODEL_REGISTRY_MODE !== "bundled",
  onError = () => {},
  startupDelayMs = 5000,
  intervalMs = 15 * 60 * 1000,
  timeoutMs = 15000,
}) {
  const backupPath = `${cachePath}.backup`;
  // acceptCatalog never throws: an invalid bundled catalog is used as shipped.
  let snapshot = {
    data: acceptCatalog(bundledSnapshot.data, bundledSnapshot.data, appVersion),
    manifestVersion: bundledSnapshot.manifestVersion,
  };
  let etag = null;
  let inFlight = null;
  let controller = null;
  let startupTimer = null;
  let interval = null;
  let stopped = false;
  let started = false;

  function reportError(error) {
    try {
      Promise.resolve(onError(error)).catch(() => {});
    } catch {
      // Diagnostics must never turn recoverable registry errors into startup failures.
    }
  }

  function apply(next) {
    try {
      applySnapshot(next);
    } catch (error) {
      reportError(error);
    }
    snapshot = next;
  }

  // Returns true when the bytes hold a newer catalog that is now applied, false when they
  // hold this or an older version. Throws for anything untrusted or not meant for us.
  function accept(bytes) {
    const manifest = validateManifest(verifyEnvelope(bytes, trustedKeys));
    if (!manifest.testedClientContracts.includes(clientContract))
      throw new Error(`Catalog ${manifest.manifestVersion} was not tested with this app version`);
    if (stopped || manifest.manifestVersion <= snapshot.manifestVersion) return false;
    if (manifest.manifestVersion > snapshot.manifestVersion + MAX_VERSION_STEP)
      throw new Error(`Catalog version ${manifest.manifestVersion} is implausibly far ahead`);
    apply({
      data: acceptCatalog(manifest.data, bundledSnapshot.data, appVersion),
      manifestVersion: manifest.manifestVersion,
    });
    return true;
  }

  // Keeps the previous good copy as a backup, so one damaged file never loses the catalog.
  async function persist(bytes) {
    const temporary = `${cachePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(cachePath, backupPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rename(temporary, cachePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      reportError(error);
    }
  }

  function refresh() {
    if (!isEnabled() || stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    // Race the entire response read, including a stalled body. The fetch
    // implementation also receives the signal to release network resources.
    const abort = new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Registry request aborted")), {
        once: true,
      })
    );
    inFlight = (async () => {
      try {
        const response = await Promise.race([
          fetch(REGISTRY_URL, {
            method: "GET",
            credentials: "omit",
            useSessionCookies: false,
            cache: "no-store",
            redirect: "error",
            headers: etag ? { "If-None-Match": etag } : {},
            signal,
          }),
          abort,
        ]);
        if (response.status === 304) return;
        const bytes = await Promise.race([readBoundedResponse(response), abort]);
        if (stopped || signal.aborted) return;
        if (accept(bytes)) await persist(bytes);
        etag = response.headers.get("etag");
      } catch (error) {
        if (!stopped) reportError(error);
      } finally {
        clearTimeout(timer);
        controller = null;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function restoreCache() {
    for (const file of [cachePath, backupPath]) {
      try {
        accept(await readBoundedCache(file));
        return true;
      } catch (error) {
        if (error.code !== "ENOENT") reportError(error);
      }
    }
    return false;
  }

  async function start() {
    if (started || stopped) return;
    started = true;
    apply(snapshot);
    if (!isEnabled()) return;
    // With no usable cached copy, fetch at once rather than leave remote additions
    // missing for the first minutes of the session.
    const restored = await restoreCache();
    if (stopped) return;
    startupTimer = setTimeout(
      () => {
        void refresh();
      },
      restored ? startupDelayMs : 0
    );
    interval = setInterval(() => {
      void refresh();
    }, intervalMs);
    startupTimer.unref?.();
    interval.unref?.();
  }

  function stop() {
    stopped = true;
    clearTimeout(startupTimer);
    clearInterval(interval);
    controller?.abort();
  }
  return { start, refresh, stop, getSnapshot: () => structuredClone(snapshot) };
}
module.exports = { createRegistryLoader, REGISTRY_URL, MAX_VERSION_STEP };
