const fs = require("node:fs/promises");
const path = require("node:path");
const { verifyEnvelope, MAX_ENVELOPE_BYTES } = require("../models/registryEnvelope.cjs");
const {
  validateManifest,
  assertCompatibleCatalog,
  selectCatalog,
} = require("../models/registrySchema.cjs");

const REGISTRY_URL =
  "https://raw.githubusercontent.com/OpenWhispr/model-registry/published/manifest.json";

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
  trustedKeys,
  appVersion,
  applySnapshot,
  fetch,
  mode = process.env.OPENWHISPR_MODEL_REGISTRY_MODE,
  onError = () => {},
  startupDelayMs = 5000,
  intervalMs = 15 * 60 * 1000,
  timeoutMs = 15000,
}) {
  // Canonical data retains future-version entries; visible data is filtered.
  // Comparing a full publication against a filtered baseline would shift order.
  let snapshot = { ...bundledSnapshot, data: selectCatalog(bundledSnapshot.data, {}, appVersion) };
  let canonical = structuredClone(bundledSnapshot.data);
  let inFlight = null;
  let controller = null;
  let startupTimer = null;
  let interval = null;
  let stopped = false;
  let started = false;

  function accept(bytes) {
    const manifest = validateManifest(verifyEnvelope(bytes, trustedKeys));
    if (stopped || manifest.manifestVersion <= snapshot.manifestVersion) return false;
    assertCompatibleCatalog(manifest.data, bundledSnapshot.data);
    assertCompatibleCatalog(manifest.data, canonical);
    const next = {
      data: selectCatalog(manifest.data, snapshot.data, appVersion),
      manifestVersion: manifest.manifestVersion,
    };
    applySnapshot(next);
    canonical = manifest.data;
    snapshot = next;
    return true;
  }

  async function persist(bytes) {
    const temporary = `${cachePath}.tmp`;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, cachePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      onError(error);
    }
  }

  function refresh() {
    if (mode === "bundled" || stopped) return Promise.resolve();
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
        const bytes = await Promise.race([
          (async () =>
            readBoundedResponse(
              await fetch(REGISTRY_URL, {
                method: "GET",
                credentials: "omit",
                useSessionCookies: false,
                cache: "no-store",
                redirect: "error",
                signal,
              })
            ))(),
          abort,
        ]);
        if (!stopped && !signal.aborted && accept(bytes)) await persist(bytes);
      } catch (error) {
        if (!stopped) onError(error);
      } finally {
        clearTimeout(timer);
        controller = null;
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function start() {
    if (started || stopped || mode === "bundled") return;
    started = true;
    try {
      accept(await readBoundedCache(cachePath));
    } catch (error) {
      if (error.code !== "ENOENT") onError(error);
    }
    if (stopped) return;
    startupTimer = setTimeout(() => {
      void refresh();
    }, startupDelayMs);
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
module.exports = { createRegistryLoader, REGISTRY_URL };
