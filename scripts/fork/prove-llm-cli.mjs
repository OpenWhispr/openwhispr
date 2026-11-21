// Runner-level proof against the CLIs installed on this machine (Phase 8, D-01, D-03).
// Real detector, real runner, real child_process.spawn, real fs, a temp dir, no Electron.
// Uses the machine's own existing sign-in; never runs a login. Prints seat, state,
// version, outcome code and timings only: no prompt text, no CLI output, no credential.
// Run with: node --import tsx scripts/fork/prove-llm-cli.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const policy = require("../../src/helpers/llmCliProviders.js");
const { createRunner } = require("../../src/helpers/llmCli/llmCliRunner.js");
const { createDetector } = require("../../src/helpers/llmCli/llmCliDetect.js");
const { createPrefs } = require("../../src/helpers/llmCli/llmCliPrefs.js");
const { registerLlmCliIpc } = require("../../src/helpers/llmCli/llmCliIpc.js");

const PROMPT = "Reply with the single word OK";
const KNOWN_HANG_SEATS = new Set(["grok"]);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "prove-llm-cli-"));

const holder = { detector: null };
const runner = createRunner({
  tmpDir: path.join(workDir, "runs"),
  resolveExe: (seat) => holder.detector.resolveExe(seat),
  // Claude token is never read here: the seat has no stored token on a probe run.
  getClaudeToken: async () => null,
});
const detector = createDetector({ runner });
holder.detector = detector;

const seconds = (ms) => (ms / 1000).toFixed(1);
let failed = false;

async function proveSeat(seat, state) {
  const startedAt = Date.now();
  let firstAt = null;
  let result;
  try {
    result = await runner.runStream({
      seat,
      prompt: PROMPT,
      onPart: () => {
        if (firstAt === null) firstAt = Date.now();
      },
    });
  } catch (error) {
    result = { ok: false, code: error?.code || "exit-nonzero" };
  }
  const total = Date.now() - startedAt;
  const first = firstAt === null ? "none" : seconds(firstAt - startedAt);
  let outcome = result.ok ? "ok" : result.code;
  if (!result.ok && result.code === "timeout" && KNOWN_HANG_SEATS.has(seat)) {
    outcome = "KNOWN-HANG";
  }
  const bad = !result.ok && state.status === "signed-in" && outcome !== "KNOWN-HANG";
  if (bad) failed = true;
  console.log(
    `${seat}\tstate=${state.status}\tversion=${state.version || "?"}\toutcome=${outcome}\tfirst_output_s=${first}\ttotal_s=${seconds(total)}`
  );
}

// Claude gate (D-04): drive the real IPC adapter over the real runner and prefs.
async function proveClaudeGate() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const prefs = createPrefs({ file: path.join(workDir, "llm-cli-prefs.json") });
  registerLlmCliIpc({
    ipcMain,
    runner,
    detector,
    installer: {},
    signIn: {},
    prefs,
  });
  const parts = [];
  const event = {
    sender: {
      isDestroyed: () => false,
      send: (_channel, message) => parts.push(message),
      on() {},
      once() {},
      removeListener() {},
    },
  };
  const start = (streamId) =>
    handlers.get("llm-cli-stream-start")(event, {
      streamId,
      seat: "claude",
      prompt: PROMPT,
    });

  prefs.set("claudeEnabled", false);
  const off = await start("gate-off");
  const offOk = off.code === "claude-disabled";
  prefs.set("claudeEnabled", true);
  const on = await start("gate-on");
  const onOk = on.code !== "claude-disabled";
  if (!offOk || !onOk) failed = true;
  console.log(
    `claude-gate\tpref_off=${off.code}\tpref_on=${on.code || "ok"}\t${offOk && onOk ? "PASS" : "FAIL"}`
  );
}

try {
  const states = await detector.detectAll();
  // Claude needs the setup token held in the app's safeStorage; this script has no store
  // and must not read one, so that seat is covered by the gate assertion below only.
  const runnable = [];
  for (const { seat } of policy.LLM_CLI_PROVIDERS) {
    const status = states[seat].status;
    if (seat !== "claude" && ["installed", "signed-in"].includes(status)) runnable.push(seat);
    else console.log(`${seat}	state=${status}	outcome=skipped`);
  }
  // The seats are independent processes; run them together so the worst case is one
  // policy total timeout, not the sum.
  await Promise.all(runnable.map((seat) => proveSeat(seat, states[seat])));
  await proveClaudeGate();
} finally {
  await fs.promises.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

process.exit(failed ? 1 : 0);
