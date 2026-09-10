/**
 * Live STT canary. Per keyed provider, acquires a session credential through
 * the app's REAL token registry (realtimeTokenProviders.js) and, where the
 * transport is a plain WebSocket, performs a live handshake against the same
 * endpoint the app dials — so a provider changing its auth, endpoint, or
 * handshake surfaces here on a schedule instead of in a customer report
 * (#1624 sat in shipped builds for three days as a swallowed warmup warning).
 * Providers whose request shape is theirs alone rather than the shared
 * OpenAI-compatible multipart (Gemini, batch and Live) send a real
 * transcription through the shipped module for the same reason, and OpenAI's
 * batch default is posted the way the app builds it so a retired model or
 * field surfaces here too.
 *
 * Run: node scripts/stt-canary.mjs
 * Keys come from STT_CANARY_<PROVIDER>_KEY env vars; providers without a key
 * are skipped and listed. Exit 1 when any probe on a keyed provider fails, or
 * when no key is configured at all — an all-skip run probed nothing and must
 * not report green.
 * Corti is not probed (needs tenant/environment credentials beyond a key).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import ffmpegPath from "ffmpeg-static";
import tokenProviders from "../src/helpers/realtimeTokenProviders.js";
import audioUtils from "../src/utils/audioUtils.js";
import geminiTranscription from "../src/helpers/geminiTranscription.js";
import geminiLive from "../src/helpers/geminiLiveStreaming.js";
import AssemblyAiStreaming from "../src/helpers/assemblyAiStreaming.js";
import modelRegistryData from "../src/models/modelRegistryData.json" with { type: "json" };

const { fetchRealtimeTokenForProvider } = tokenProviders;
const { pcm16ToWav } = audioUtils;
const { transcribeWithGemini } = geminiTranscription;
const { GeminiLiveStreaming } = geminiLive;

// The registry's first model is what a fresh AssemblyAI selection dictates with
// (ModelRegistry.getDefaultTranscriptionModel), so that is the id to probe.
const ASSEMBLYAI_DEFAULT_MODEL = modelRegistryData.transcriptionProviders.find(
  (provider) => provider.id === "assemblyai"
).models[0].id;

const HANDSHAKE_TIMEOUT_MS = 15000;
// Half a second of 16 kHz mono silence: enough for a provider to accept and
// decode the container, short enough to stay far inside every request cap.
const SILENT_WAV = () => pcm16ToWav(Buffer.alloc(16000));

// Mirrors the app's dial: openaiRealtimeStreaming.js connects with a bare
// Bearer header; deepgramStreaming.js passes the key as the bearer token; a
// null token means the credential already rides in the URL (AssemblyAI).
// `awaitServerEvent` is for providers that authenticate AFTER the upgrade:
// OpenAI opens the socket for any key and only then sends an `error` event
// for a bad one, so resolving on `open` validates nothing (#1624 class).
// `verifyServerEvent` inspects that first event and returns a failure detail,
// or null to accept — for servers that acknowledge the requested configuration
// rather than reject a bad one.
function probeWebSocket(url, token, { awaitServerEvent = false, verifyServerEvent = null } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      url,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    );
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ ok: false, detail: `no handshake within ${HANDSHAKE_TIMEOUT_MS}ms` });
    }, HANDSHAKE_TIMEOUT_MS);
    const finish = (result) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(result);
    };
    ws.on("open", () => {
      if (!awaitServerEvent) finish({ ok: true });
    });
    ws.on("message", (data) => {
      if (!awaitServerEvent) return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        event = {};
      }
      if (event.type === "error") {
        finish({ ok: false, detail: `server error event: ${event.error?.code ?? "unknown"}` });
        return;
      }
      const detail = verifyServerEvent?.(event);
      finish(detail ? { ok: false, detail } : { ok: true });
    });
    ws.on("close", (code) => {
      if (awaitServerEvent)
        finish({ ok: false, detail: `closed before a server event (code ${code})` });
    });
    ws.on("unexpected-response", (_req, res) => {
      finish({ ok: false, detail: `handshake rejected: HTTP ${res.statusCode}` });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
  });
}

// Dictation records WebM/Opus, and Gemini's documented input formats do not
// list it — so wav and webm are probed separately: a wav-only probe would stay
// green while every BYOK dictation failed.
function toWebmOpus(wav) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-canary-"));
  const input = path.join(dir, "in.wav");
  const output = path.join(dir, "out.webm");
  try {
    fs.writeFileSync(input, wav);
    const result = spawnSync(ffmpegPath, ["-y", "-i", input, "-c:a", "libopus", output], {
      stdio: "ignore",
    });
    if (result.status !== 0) return null;
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A completed interaction proves auth, endpoint, and container decode; silence
// legitimately transcribes to empty text, so text content is not asserted.
async function probeGeminiBatch(key, audio, contentType) {
  if (!audio) return { ok: false, detail: `could not build ${contentType} fixture` };
  await transcribeWithGemini({ audioBuffer: audio, contentType, apiKey: key }, fetch);
  return { ok: true };
}

// A completed Live turn proves the raw-key handshake, the setup message, the
// audio frame shape and the transcript events — the socket opening proves none
// of it, and server-side VAD suppresses silence, so the probe has to speak.
const CANARY_PHRASE = "The quick brown fox. OpenWhispr transcription test.";
const LIVE_FRAME_MS = 50;
const LIVE_FRAME_BYTES = 1600; // one 50ms dictation worklet frame at 16kHz s16le

// Gemini's own TTS keeps the fixture out of the repo and needs no second key.
async function synthesizeCanarySpeech(key) {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Say clearly: ${CANARY_PHRASE}` }] }],
        generationConfig: { responseModalities: ["AUDIO"] },
      }),
    }
  );
  if (!response.ok) throw new Error(`speech fixture request failed: HTTP ${response.status}`);
  const data = await response.json();
  const audio = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!audio) throw new Error("speech fixture returned no audio");
  // TTS answers with 24kHz L16; dictation captures 16kHz.
  const resampled = spawnSync(
    ffmpegPath,
    [
      "-f",
      "s16le",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ],
    { input: Buffer.from(audio, "base64"), maxBuffer: 64 * 1024 * 1024 }
  );
  if (resampled.status !== 0) throw new Error("could not resample the speech fixture to 16kHz");
  return resampled.stdout;
}

async function probeGeminiLive(key) {
  const token = await fetchRealtimeTokenForProvider("gemini-realtime", tokenDeps(key), {
    mode: "byok",
  });
  const pcm = await synthesizeCanarySpeech(key);
  const streaming = new GeminiLiveStreaming();
  let partials = 0;
  streaming.onPartialTranscript = () => {
    partials += 1;
  };
  try {
    await streaming.connect({ token, mode: "byok", keyterms: ["OpenWhispr"] });
    // Paced like the mic worklet: the server finalizes relative to real-time
    // ingest, so a burst followed by audioStreamEnd starves the final.
    for (let offset = 0; offset < pcm.length; offset += LIVE_FRAME_BYTES) {
      streaming.sendAudio(pcm.subarray(offset, offset + LIVE_FRAME_BYTES));
      await new Promise((resolve) => setTimeout(resolve, LIVE_FRAME_MS));
    }
    const { text } = await streaming.disconnect(true);
    if (!/quick brown fox/i.test(text)) {
      return { ok: false, detail: `no usable transcript: ${JSON.stringify(text)}` };
    }
    return { ok: true, note: `${partials} partials, final "${text}"` };
  } finally {
    streaming.cleanup();
  }
}

// gpt-transcribe is the BYOK batch default and takes the custom dictionary on
// its `keywords[]` channel, so one rides along: the request fails here first if
// OpenAI retires either. Silence transcribes to empty text, so only acceptance
// is asserted.
async function probeOpenAiBatch(key, audio) {
  const body = new FormData();
  body.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  body.append("model", "gpt-transcribe");
  body.append("keywords[]", "OpenWhispr");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body,
  });
  return response.ok ? { ok: true } : { ok: false, detail: `HTTP ${response.status}` };
}

const tokenDeps = (key) => ({
  environmentManager: {
    getOpenAIKey: () => key,
    getTinfoilKey: () => key,
    getDeepgramKey: () => key,
    getAssemblyAIKey: () => key,
    getGeminiKey: () => key,
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
      return probeWebSocket("wss://api.openai.com/v1/realtime?intent=transcription", token, {
        awaitServerEvent: true,
      });
    },
  },
  {
    id: "openai-batch",
    keyEnv: "STT_CANARY_OPENAI_KEY",
    run: (key) => probeOpenAiBatch(key, SILENT_WAV()),
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
    // Dials the exact URL the client builds (token, encoding, speech_model).
    // AssemblyAI ignores query params it does not recognise instead of
    // rejecting them, so a retired or misspelt default model would silently
    // downgrade every session — only Begin's echoed configuration.model proves
    // the requested model was applied.
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("assemblyai-realtime", tokenDeps(key), {
        mode: "byok",
      });
      const model = ASSEMBLYAI_DEFAULT_MODEL;
      const url = new AssemblyAiStreaming().buildWebSocketUrl({ token, model });
      return probeWebSocket(url, null, {
        awaitServerEvent: true,
        verifyServerEvent: (event) =>
          event.type === "Begin" && event.configuration?.model === model
            ? null
            : `expected Begin with model ${model}, got ${event.type ?? "unknown"} (model ${event.configuration?.model ?? "none"})`,
      });
    },
  },
  {
    id: "tinfoil-realtime",
    keyEnv: "STT_CANARY_TINFOIL_KEY",
    // The attested socket needs the Tinfoil SDK's enclave verification; the
    // canary stops at credential resolution, so this row only proves the
    // secret exists.
    run: async (key) => {
      const token = await fetchRealtimeTokenForProvider("tinfoil-realtime", tokenDeps(key), {
        mode: "byok",
      });
      return token
        ? { ok: true, note: "key present (transport not probed)" }
        : { ok: false, detail: "empty token" };
    },
  },
  {
    id: "gemini-live-streaming",
    keyEnv: "STT_CANARY_GEMINI_KEY",
    run: (key) => probeGeminiLive(key),
  },
  {
    id: "gemini-batch-wav",
    keyEnv: "STT_CANARY_GEMINI_KEY",
    run: (key) => probeGeminiBatch(key, SILENT_WAV(), "audio/wav"),
  },
  {
    id: "gemini-batch-webm",
    keyEnv: "STT_CANARY_GEMINI_KEY",
    run: (key) => probeGeminiBatch(key, toWebmOpus(SILENT_WAV()), "audio/webm"),
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
  const cell = result.ok ? `✅${result.note ? ` ${result.note}` : ""}` : `❌ ${result.detail}`;
  report.push(`| ${probe.id} | ${cell} |`);
  if (!result.ok) failures.push(`${probe.id}: ${result.detail}`);
}

if (skipped.length === PROBES.length) {
  failures.push("no canary secrets configured — every provider was skipped, nothing was probed");
}

console.log("## STT canary\n");
console.log("| provider | result |\n|---|---|");
for (const line of report) console.log(line);
if (skipped.length) console.log(`\nSkipped (no key configured): ${skipped.join(", ")}`);
if (failures.length) {
  console.log(`\n### ${failures.length} failure(s)\n`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log("\nAll probes passed.");
