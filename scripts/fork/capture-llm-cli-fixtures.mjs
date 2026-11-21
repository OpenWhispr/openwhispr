// Read-only live capture of each subscription CLI's real headless output into
// test/fixtures/llm-cli. Uses the machine's own existing sign-in; never runs a
// login, never prints or stores a credential. Every written file passes
// scrubFixture. Run with: node --import tsx scripts/fork/capture-llm-cli-fixtures.mjs
//   --verify-only   only probe `--help` for every requiredFlags entry
//   --seat <name>   limit to one seat (claude|codex|grok|agy)
//   --models        also print each `models` listing (grok, agy)
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const policy = require("../../src/helpers/llmCliProviders.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../../test/fixtures/llm-cli");
const PROMPT = "Reply with the single word OK";

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify-only");
const wantModels = args.includes("--models");
const seatFlag = args.indexOf("--seat");
const onlySeat = seatFlag >= 0 ? args[seatFlag + 1] : null;

const platform = process.platform;
const seats = policy.LLM_CLI_PROVIDERS.map((p) => p.seat).filter(
  (s) => !onlySeat || s === onlySeat
);

function resolveExe(seat) {
  for (const candidate of policy.detectionCandidates(seat, platform, process.env)) {
    if (candidate.spawnable && fs.existsSync(candidate.path)) return candidate.path;
  }
  return null;
}

function killTree(child) {
  if (!child.pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

function run(exe, argv, { env, stdin, idleMs, totalMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(exe, argv, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = null;
    let idleTimer;
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = "idle";
        killTree(child);
      }, idleMs);
    };
    const totalTimer = setTimeout(() => {
      timedOut = "total";
      killTree(child);
    }, totalMs);
    arm();
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      arm();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      arm();
    });
    child.on("error", (err) => {
      stderr += `spawn error: ${err.code || err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      resolve({ code, stdout, stderr, timedOut, seconds: (Date.now() - started) / 1000 });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function runShort(exe, argv, env, ms) {
  const r = spawnSync(exe, argv, { env, encoding: "utf8", timeout: ms, windowsHide: true });
  return `${r.stdout || ""}\n${r.stderr || ""}`;
}

// The raw claude stream carries this machine's hook output and the init event's
// tool, plugin and skill inventory. Keep every event the parsers read; drop the
// hook events and reduce system init/status to their identifying fields.
function trimClaudeStream(text) {
  const kept = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "system") {
      if (typeof obj.subtype === "string" && obj.subtype.startsWith("hook_")) continue;
      kept.push(
        JSON.stringify({
          type: obj.type,
          subtype: obj.subtype,
          model: obj.model,
          session_id: obj.session_id,
        })
      );
      continue;
    }
    kept.push(line);
  }
  return `${kept.join("\n")}\n`;
}

function write(name, text) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, name), policy.scrubFixture(text));
}

async function verifyFlags(seat, exe) {
  const row = policy.getProvider(seat);
  const env = policy.buildChildEnv(seat, process.env);
  const version = policy.parseVersion(
    seat,
    runShort(exe, row.versionArgs, env, policy.TIMEOUTS.versionMs)
  );
  const help = runShort(exe, row.helpArgs, env, policy.TIMEOUTS.helpMs);
  const missing = policy.missingRequiredFlags(seat, help);
  console.log(
    `[${seat}] version=${version} tested=${row.testedVersion} missingFlags=${JSON.stringify(missing)}`
  );
  return missing.length === 0;
}

const fixtureFor = {
  claude: "claude-stream.ndjson",
  codex: "codex-last-message.txt",
  grok: "grok-json.txt",
  agy: "agy-json.txt",
};

async function capture(seat, exe) {
  const env = policy.buildChildEnv(seat, process.env);
  const base = { env, idleMs: policy.TIMEOUTS.idleMs, totalMs: policy.TIMEOUTS.totalMs };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `llm-cli-${seat}-`));
  let result;
  let text;
  let outcome;
  if (seat === "claude") {
    result = await run(exe, policy.buildRunArgv("claude", { model: "haiku" }), {
      ...base,
      stdin: PROMPT,
    });
    text = trimClaudeStream(result.stdout);
  } else if (seat === "codex") {
    const outputFile = path.join(tmp, "last.txt");
    result = await run(exe, policy.buildRunArgv("codex", { outputFile }), {
      ...base,
      stdin: PROMPT,
    });
    text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  } else if (seat === "grok") {
    const promptFile = path.join(tmp, "prompt.txt");
    fs.writeFileSync(promptFile, PROMPT);
    result = await run(exe, policy.buildRunArgv("grok", { promptFile }), base);
    text = result.stdout;
  } else {
    const printTimeoutSeconds = policy.agyPrintTimeoutSeconds(policy.TIMEOUTS.totalMs);
    result = await run(
      exe,
      policy.buildRunArgv("agy", { prompt: PROMPT, printTimeoutSeconds }),
      base
    );
    text = result.stdout;
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (result.timedOut) {
    outcome = `timeout(${result.timedOut})`;
    if (text.trim().length === 0) text = JSON.stringify({ timeout: true });
  } else {
    const code = policy.classifyStderr(seat, result.stderr);
    outcome = result.code === 0 ? "ok" : `exit ${result.code}${code ? ` (${code})` : ""}`;
  }
  write(fixtureFor[seat], text);
  const stderrClass = policy.classifyStderr(seat, result.stderr);
  console.log(
    `| ${seat} | ${fixtureFor[seat]} | ${result.seconds.toFixed(1)} | ${outcome} | stderr=${stderrClass || "none"} |`
  );
}

let allOk = true;
for (const seat of seats) {
  const exe = resolveExe(seat);
  if (!exe) {
    console.log(`[${seat}] not found on this machine`);
    allOk = false;
    continue;
  }
  const flagsOk = await verifyFlags(seat, exe);
  allOk = allOk && flagsOk;
  if (wantModels && (seat === "grok" || seat === "agy")) {
    const listing = runShort(exe, ["models"], policy.buildChildEnv(seat, process.env), 15000);
    console.log(
      `[${seat}] models:\n${policy.scrubFixture(listing).split("\n").slice(0, 30).join("\n")}`
    );
  }
  if (!verifyOnly) await capture(seat, exe);
}
process.exit(allOk ? 0 : 1);
