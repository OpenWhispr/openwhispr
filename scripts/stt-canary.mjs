/**
 * Live realtime-STT canary. Per keyed provider, acquires a session credential
 * through the app's REAL token registry (realtimeTokenProviders.js) and, where
 * the transport is a plain WebSocket, performs a live handshake against the
 * same endpoint the app dials — so a provider changing its auth, endpoint, or
 * handshake surfaces here on a schedule instead of in a customer report
 * (#1624 sat in shipped builds for three days as a swallowed warmup warning).
 *
 * Run: node scripts/stt-canary.mjs
 * Keys come from STT_CANARY_<PROVIDER>_KEY env vars; providers without a key
 * are skipped and listed. Exit 1 when any probe on a keyed provider fails.
 * Corti is not probed (needs tenant/environment credentials beyond a key).
 */
import WebSocket from "ws";
import tokenProviders from "../src/helpers/realtimeTokenProviders.js";

const { fetchRealtimeTokenForProvider } = tokenProviders;

const HANDSHAKE_TIMEOUT_MS = 15000;

// Mirrors the app's dial: openaiRealtimeStreaming.js connects with a bare
// Bearer header; deepgramStreaming.js passes the key as the bearer token.
function probeWebSocket(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, detail: `no handshake within ${HANDSHAKE_TIMEOUT_MS}ms` });
    }, HANDSHAKE_TIMEOUT_MS);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve({ ok: true });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ ok: false, detail: `handshake rejected: HTTP ${res.statusCode}` });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
  });
}

const tokenDeps = (key) => ({
  environmentManager: {
    getOpenAIKey: () => key,
    getTinfoilKey: () => key,
    getDeepgramKey: () => key,
    getAssemblyAIKey: () => key,
  },
  proxyFetch: fetch,
});

const PROBES = [
  {
    id: "openai-realtime",
    keyEnv: "STT_CANARY_OPENAI_KEY",
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("openai-realtime", tokenDeps(key), {
        mode: "byok",
      });
      return probeWebSocket("wss://api.openai.com/v1/realtime?intent=transcription", token);
    },
  },
  {
    id: "deepgram-realtime",
    keyEnv: "STT_CANARY_DEEPGRAM_KEY",
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("deepgram-realtime", tokenDeps(key), {
        mode: "byok",
      });
      return probeWebSocket(
        "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000",
        token
      );
    },
  },
  {
    id: "assemblyai-realtime",
    keyEnv: "STT_CANARY_ASSEMBLYAI_KEY",
    // AssemblyAI's byok path mints a real short-lived streaming token, so the
    // registry call itself is the live probe.
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("assemblyai-realtime", tokenDeps(key), {
        mode: "byok",
      });
      return token ? { ok: true } : { ok: false, detail: "empty token" };
    },
  },
  {
    id: "tinfoil-realtime",
    keyEnv: "STT_CANARY_TINFOIL_KEY",
    // The attested socket needs the Tinfoil SDK's enclave verification; the
    // canary stops at credential resolution through the registry.
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("tinfoil-realtime", tokenDeps(key), {
        mode: "byok",
      });
      return token ? { ok: true } : { ok: false, detail: "empty token" };
    },
  },
];

const report = [];
const failures = [];
const skipped = [];

for (const probe of PROBES) {
  const key = process.env[probe.keyEnv];
  if (!key) {
    skipped.push(probe.id);
    continue;
  }
  const result = await probe.run(key).catch((err) => ({ ok: false, detail: err.message }));
  report.push(`| ${probe.id} | ${result.ok ? "✅" : `❌ ${result.detail}`} |`);
  if (!result.ok) failures.push(`${probe.id}: ${result.detail}`);
}

console.log("## Realtime STT canary\n");
console.log("| provider | result |\n|---|---|");
for (const line of report) console.log(line);
if (skipped.length) console.log(`\nSkipped (no key configured): ${skipped.join(", ")}`);
if (failures.length) {
  console.log(`\n### ${failures.length} failure(s)\n`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log("\nAll probes passed.");
