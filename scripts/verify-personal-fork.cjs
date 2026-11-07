#!/usr/bin/env node
"use strict";

/*
 * Headless real-Electron UI regression check for the personal BYOK fork.
 *
 * Launches the actual built app (main.js + compiled renderer in src/dist) on an
 * isolated Xvfb display with throw-away HOME/XDG/userData directories, attaches
 * playwright-core over a loopback CDP port *before* any window exists, and drives
 * the real Settings UI with trusted pointer/keyboard input.
 *
 * Verifies (UI only; provider transport behaviour is covered by the node tests):
 *   - account-free personal UI: no sign-in / upgrade / plans / workspace surface
 *   - OpenRouter LLM cleanup manual model id `vendor/example:nitro`
 *   - OpenRouter speech-to-text manual model id `vendor/example:nitro`
 *   - Gemini Smart cleanup toggle (default off)
 *   - persistence across a renderer reload and a real application restart
 *
 * Requirements (installed by the caller, never by this script):
 *   - `npm ci` already run in the checkout (node_modules/electron present)
 *   - `npm run build:renderer` already run (src/dist/index.html present)
 *   - playwright-core resolvable via NODE_PATH (or PLAYWRIGHT_CORE_PATH) from a
 *     separate tooling directory; xvfb-run (+ xauth) on PATH unless the caller
 *     already runs under Xvfb and sets OPENWHISPR_VERIFY_XVFB=1
 *
 * No network is used: every http(s) request from the renderer is blocked and
 * recorded as "expected offline", except the OpenRouter model-catalog URLs which
 * are answered by an explicitly labelled SYNTHETIC fixture. No credentials are
 * entered and no provider call is made.
 *
 * Output: one JSON document on stdout. Exit 0 = pass, 1 = failed check,
 * 2 = environment blocker (nothing was verified).
 */

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const https = require("https");

const REPO = path.resolve(__dirname, "..");
const TOTAL_BUDGET_MS = 180000; // hard limit enforced by the wrapper
const INNER_BUDGET_MS = 160000; // inner watchdog; leaves time to print + clean up
const STARTED = Date.now();

const MODEL_ID = "vendor/example:nitro";
const SYNTHETIC_LABEL =
  "SYNTHETIC CATALOG FIXTURE (openwhispr verify-personal-fork) - not real OpenRouter data";
const FIXTURE_NAME = "Synthetic Verification Example";

const FORBIDDEN_UI =
  /sign(?:ed)?[\s-]?(?:in|up|out)|log[\s-]?in (?:to|with)|upgrade|\bplans?\b|pricing|billing|subscription|free trial|workspace|create (?:an )?account|openwhispr (?:pro|cloud|account)/i;
const FORBIDDEN_NAV_LABELS = ["Profile", "Plans & Billing", "Workspace", "Account"];

const COVERAGE_GAPS = [
  "Global hotkeys, native paste/text insertion, tray and the real microphone are not exercised under Xvfb.",
  "No transcription, cleanup or other provider request is made; provider transport is covered by the focused node tests.",
  "Note Recording and Audio Upload speech-to-text tabs, Voice Assistant/Translation/Note Formatting/Chat model tabs and Enterprise/Local/Self-Hosted panels are not interacted with.",
  "Main-process (Node-side) network requests are not observable over CDP; only renderer requests and Chromium-stack DNS (blocked) are covered.",
  "Onboarding flow is bypassed by seeding only localStorage.onboardingCompleted=true; onboarding screens are not verified.",
  "Compact recorder window is only text-scanned for account surfaces, not interacted with.",
];

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`[verify-personal-fork] ${a.join(" ")}\n`);
const elapsed = () => Math.round((Date.now() - STARTED) / 100) / 10;

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function waitFor(fn, { timeout = 15000, interval = 150, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      throw new Error(`timeout waiting for ${what}${last ? `: ${last.message}` : ""}`);
    }
    await sleep(interval);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function emit(result, code) {
  const json = `${JSON.stringify(result)}\n`;
  const file = process.env.OPENWHISPR_VERIFY_RESULT_FILE;
  if (file) {
    // xvfb-run merges the command's stderr into stdout, so the wrapper prints the JSON itself.
    try {
      fs.writeFileSync(file, json);
    } catch {
      /* wrapper reports a missing result */
    }
    process.exit(code);
    return;
  }
  process.stdout.write(json, () => process.exit(code));
}

// ---------------------------------------------------------------------------
// Wrapper: ensure an isolated Xvfb display and a hard 180s ceiling.
// ---------------------------------------------------------------------------

function wrapUnderXvfb() {
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-verify-result-"));
  const resultFile = path.join(resultDir, "result.json");
  const cleanupResult = () => {
    try {
      fs.rmSync(resultDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      "-s",
      "-screen 0 1440x900x24 -nolisten tcp",
      process.execPath,
      __filename,
      ...process.argv.slice(2),
    ],
    {
      cwd: REPO,
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        OPENWHISPR_VERIFY_XVFB: "1",
        OPENWHISPR_VERIFY_RESULT_FILE: resultFile,
      },
    }
  );
  // Progress goes to stderr so stdout stays a single JSON document.
  child.stdout.on("data", (d) => process.stderr.write(d));
  let done = false;
  let timedOut = false;
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => {
    if (done) return;
    timedOut = true;
    log(`hard timeout ${TOTAL_BUDGET_MS}ms reached; terminating Xvfb wrapper group`);
    killGroup("SIGKILL");
  }, TOTAL_BUDGET_MS);
  child.on("error", (err) => {
    done = true;
    clearTimeout(timer);
    cleanupResult();
    emit_stdout(
      {
        ok: false,
        blocker: `cannot run xvfb-run (install xvfb and xauth, or run under Xvfb with OPENWHISPR_VERIFY_XVFB=1): ${err.message}`,
      },
      2
    );
  });
  child.on("exit", (code, signal) => {
    done = true;
    clearTimeout(timer);
    killGroup("SIGKILL"); // sweep any stragglers (Xvfb, helpers) in the group
    let json = null;
    try {
      json = fs.readFileSync(resultFile, "utf8");
    } catch {
      /* none written */
    }
    cleanupResult();
    if (json) {
      process.stdout.write(json, () => process.exit(code === null ? 1 : code));
    } else {
      emit_stdout(
        {
          ok: false,
          error: timedOut
            ? `hard timeout ${TOTAL_BUDGET_MS}ms; no result written`
            : `no result written (exit code ${code}, signal ${signal}); xvfb-run may have failed to start Xvfb`,
        },
        code || 1
      );
    }
  });
}

function emit_stdout(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(code));
}

// ---------------------------------------------------------------------------
// Process ownership: everything we start carries a unique env marker so even
// reparented helpers (e.g. the key-listener sidecar) can be found and killed.
// ---------------------------------------------------------------------------

const RUN_ID = crypto.randomBytes(8).toString("hex");
const MARKER = `OPENWHISPR_VERIFY_RUN_ID=${RUN_ID}`;

function ownedPids() {
  const pids = [];
  let entries = [];
  try {
    entries = fs.readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return pids;
  }
  for (const e of entries) {
    const pid = Number(e);
    if (pid === process.pid) continue;
    try {
      const env = fs.readFileSync(`/proc/${e}/environ`, "latin1");
      if (env.split("\0").includes(MARKER)) pids.push(pid);
    } catch {
      /* process vanished or not readable */
    }
  }
  return pids;
}

function killOwned(signal = "SIGKILL") {
  for (const pid of ownedPids()) {
    try {
      process.kill(pid, signal);
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Result ledger
// ---------------------------------------------------------------------------

const checks = [];
const ledger = {
  expected_offline: { blocked_requests: new Map(), fixture_served: new Map() },
  unexpected: {
    console_errors: [],
    pageerrors: [],
    failed_requests: [],
    http_errors: [],
    crashes: [],
  },
  console_warning_count: 0,
  console_other_count: 0,
  pages_seen: new Set(),
  preexisting_pages: [],
};
let phase = "init";

function check(name, ok, detail) {
  const rec = { name, ok: Boolean(ok) };
  if (detail !== undefined) rec.detail = detail;
  checks.push(rec);
  log(
    `${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`
  );
  return Boolean(ok);
}

function isRemote(url) {
  return (
    /^https?:\/\//i.test(url) && !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(url)
  );
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function stripQuery(url) {
  return url.split("#")[0];
}

// ---------------------------------------------------------------------------
// Synthetic catalog fixtures (the only network responses ever produced)
// ---------------------------------------------------------------------------

function fixtureFor(url) {
  const u = new URL(url);
  if (u.origin !== "https://openrouter.ai" || u.pathname !== "/api/v1/models") return null;
  const modality = u.searchParams.get("output_modalities");
  if (modality !== "transcription" && modality !== "text") return null;
  const data = [
    {
      id: "vendor/example",
      name: FIXTURE_NAME,
      description: SYNTHETIC_LABEL,
      architecture: { output_modalities: [modality] },
    },
    {
      id: "vendor/other-fixture",
      name: "Synthetic Verification Other",
      description: SYNTHETIC_LABEL,
      architecture: { output_modalities: [modality] },
    },
  ];
  return { modality, body: JSON.stringify({ data }) };
}

// ---------------------------------------------------------------------------
// Launch / attach
// ---------------------------------------------------------------------------

function makeIsolatedEnv(root, display) {
  const dirs = {
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    runtime: path.join(root, "runtime"),
    tmp: path.join(root, "tmp"),
    userData: path.join(root, "userdata"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  // Whitelist only what Electron needs; never forward tokens or the real session bus/keyring.
  const keep = ["PATH", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "TERM", "LD_LIBRARY_PATH"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.DISPLAY = display || env.DISPLAY;
  Object.assign(env, {
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    XDG_RUNTIME_DIR: dirs.runtime,
    TMPDIR: dirs.tmp,
    NO_AT_BRIDGE: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "",
    [MARKER.split("=")[0]]: RUN_ID,
  });
  return { env, dirs };
}

// Electron's webRequest hooks make CDP-fulfilled responses status 0 (Playwright
// #30495). Serve the labelled fixture over actual loopback TLS instead, without
// replacing fetch, preload, IPC or any production webRequest hook.
async function startCatalogServer(root) {
  const keyFile = path.join(root, "fixture-key.pem");
  const certFile = path.join(root, "fixture-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "1",
      "-subj",
      "/CN=openrouter.ai",
      "-addext",
      "subjectAltName=DNS:openrouter.ai",
    ],
    { stdio: "ignore", timeout: 10000 }
  );
  const cert = fs.readFileSync(certFile);
  const spki = new crypto.X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  const pin = crypto.createHash("sha256").update(spki).digest("base64");
  const server = https.createServer({ key: fs.readFileSync(keyFile), cert }, (req, res) => {
    const fx = fixtureFor(`https://openrouter.ai${req.url}`);
    if (req.method !== "GET" || !fx) {
      res.writeHead(404);
      res.end();
      return;
    }
    bump(
      ledger.expected_offline.fixture_served,
      `GET openrouter.ai/api/v1/models?output_modalities=${fx.modality}`
    );
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-openwhispr-verify-fixture": "synthetic-catalog",
      "access-control-allow-origin": "*",
    });
    res.end(fx.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port, pin };
}

async function launchApp(playwright, ctxInfo, { seed }) {
  const { root, env, dirs, electronBin, catalog } = ctxInfo;
  const cdpPort = await freePort();
  const bridgePort = await freePort();
  const logFile = path.join(root, `electron-${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  const args = [
    ".",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${dirs.userData}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    // Chromium-stack DNS is dead for everything but loopback: no accidental egress.
    `--host-resolver-rules=MAP openrouter.ai 127.0.0.1:${catalog.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    `--ignore-certificate-errors-spki-list=${catalog.pin}`,
    "--no-proxy-server",
  ];
  const proc = spawn(electronBin, args, {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...env, OPENWHISPR_AUTH_BRIDGE_PORT: String(bridgePort) },
  });
  fs.closeSync(out);
  const session = { proc, cdpPort, logFile, exited: false, exitInfo: null };
  proc.on("exit", (code, signal) => {
    session.exited = true;
    session.exitInfo = { code, signal };
  });

  // Attach as early as the debugging port exists so every window is observed from creation.
  let browser;
  const attachDeadline = Date.now() + 30000;
  for (;;) {
    if (session.exited)
      throw new Error(`electron exited before CDP attach: ${JSON.stringify(session.exitInfo)}`);
    try {
      browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
        timeout: 3000,
      });
      break;
    } catch (e) {
      if (Date.now() > attachDeadline) throw new Error(`CDP attach failed: ${e.message}`);
      await sleep(60);
    }
  }
  session.browser = browser;
  const context = browser.contexts()[0];
  session.context = context;
  const pre = context.pages().map((p) => stripQuery(p.url()));
  if (pre.length) ledger.preexisting_pages.push({ phase, pages: pre });

  const attachPage = (page) => {
    const label = () =>
      page
        .url()
        .split("#")[0]
        .replace(/^file:\/\/.*\/src\/dist\//, "dist/");
    ledger.pages_seen.add(label());
    page.on("console", (m) => {
      const type = m.type();
      const text = m.text();
      const loc = m.location() || {};
      if (type === "error") {
        if (loc.url && isRemote(loc.url)) {
          // Console twin of an intentionally blocked offline request.
          bump(ledger.expected_offline.blocked_requests, stripQuery(loc.url));
          return;
        }
        ledger.unexpected.console_errors.push({
          phase,
          page: label(),
          text: text.slice(0, 300),
          url: loc.url,
        });
      } else if (type === "warning") {
        ledger.console_warning_count++;
      } else {
        ledger.console_other_count++;
      }
    });
    page.on("pageerror", (err) => {
      ledger.unexpected.pageerrors.push({
        phase,
        page: label(),
        message: String(err && err.message).slice(0, 300),
      });
    });
    page.on("crash", () => ledger.unexpected.crashes.push({ phase, page: label() }));
    page.on("requestfailed", (req) => {
      const url = req.url();
      const reason = (req.failure() && req.failure().errorText) || "unknown";
      if (
        isRemote(url) &&
        /ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(reason)
      ) {
        bump(ledger.expected_offline.blocked_requests, stripQuery(url));
        return;
      }
      ledger.unexpected.failed_requests.push({
        phase,
        page: label(),
        url: stripQuery(url),
        reason,
      });
    });
    page.on("response", (res) => {
      const status = res.status();
      const url = res.url();
      if (status >= 400 && /^https?:/i.test(url) && !res.headers()["x-openwhispr-verify-fixture"]) {
        ledger.unexpected.http_errors.push({ phase, url: stripQuery(url), status });
      }
    });
  };
  context.on("page", attachPage);
  for (const p of context.pages()) attachPage(p);

  // Deny-by-default network for the renderer; only the labelled synthetic catalog is answered.
  await context.route(/^https?:\/\//i, async (route) => {
    const url = route.request().url();
    if (!isRemote(url)) return route.continue();
    const fx = fixtureFor(url);
    if (fx && route.request().method() === "GET") return route.continue();
    bump(ledger.expected_offline.blocked_requests, stripQuery(url));
    return route.abort("blockedbyclient");
  });

  if (seed) {
    // Only the single synthetic setting needed to skip onboarding; later launches must not reseed.
    await context.addInitScript(() => {
      try {
        if (location.protocol === "file:" && localStorage.getItem("onboardingCompleted") === null) {
          localStorage.setItem("onboardingCompleted", "true");
        }
      } catch {
        /* opaque origins cannot access storage */
      }
    });
  }
  return session;
}

async function findPanel(session) {
  return waitFor(
    async () => {
      for (const p of session.context.pages()) {
        if (!p.url().includes("panel=true")) continue;
        const ready = await p
          .evaluate(() => /\bHome\b/.test(document.body.innerText) && Boolean(window.electronAPI))
          .catch(() => false);
        if (ready) return p;
      }
      return null;
    },
    { timeout: 45000, what: "control panel window" }
  );
}

async function findRecorder(session) {
  return waitFor(
    async () => session.context.pages().find((p) => /\/index\.html$/.test(p.url())) || null,
    { timeout: 15000, what: "compact recorder window" }
  );
}

async function stopApp(session, { graceful }) {
  if (!session) return { graceful: false };
  let gracefulExit = false;
  if (session.browser) {
    await withTimeout(
      session.browser.close().catch(() => {}),
      5000,
      "browser.close"
    ).catch(() => {});
  }
  if (graceful && !session.exited) {
    try {
      process.kill(session.proc.pid, "SIGTERM");
    } catch {
      /* gone */
    }
    const end = Date.now() + 20000;
    while (!session.exited && Date.now() < end) await sleep(100);
    gracefulExit = session.exited;
  }
  if (!session.exited) {
    try {
      process.kill(-session.proc.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  killOwned("SIGKILL"); // helpers that outlive the main process
  const end = Date.now() + 5000;
  while (!session.exited && Date.now() < end) await sleep(50);
  return { graceful: gracefulExit };
}

// ---------------------------------------------------------------------------
// UI helpers (trusted pointer / keyboard input through CDP)
// ---------------------------------------------------------------------------

// Centre of the first visible control inside `scope` whose text/aria-label equals `text`.
async function locateByText(page, text, scope) {
  return page.evaluate(
    ([t, sc]) => {
      const root = (sc && document.querySelector(sc)) || document;
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const els = [...root.querySelectorAll("button,[role=tab],[role=switch],label,a")]
        .filter(vis)
        .filter(
          (e) => (e.innerText || "").trim() === t || (e.getAttribute("aria-label") || "") === t
        );
      if (!els.length) return null;
      els[0].scrollIntoView({ block: "center", inline: "center" });
      const b = els[0].getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, matches: els.length };
    },
    [text, scope || null]
  );
}

async function clickText(page, text, scope = "[role=dialog]") {
  const pos = await waitFor(() => locateByText(page, text, scope), {
    timeout: 8000,
    what: `control "${text}"`,
  });
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.click(pos.x, pos.y);
  await sleep(450);
}

async function centerOf(page, selector) {
  return page.evaluate((sel) => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    const el = [...document.querySelectorAll(sel)].find(vis);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    // A checkbox is tiny and sits inside a <label>; click the control itself.
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, selector);
}

async function clickSelector(page, selector) {
  const pos = await waitFor(() => centerOf(page, selector), {
    timeout: 8000,
    what: `selector ${selector}`,
  });
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.click(pos.x, pos.y);
  await sleep(450);
}

async function replaceText(page, selector, text) {
  await clickSelector(page, selector);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  if (text) await page.keyboard.insertText(text);
  await sleep(700);
}

const MODEL_INPUT = 'input[aria-label="Custom Model ID"]';

const readLocal = (page) => page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
const visibleText = (page, scope = "[role=dialog]") =>
  page.evaluate((sc) => {
    const root = (sc && document.querySelector(sc)) || document.body;
    return root.innerText.replace(/\n+/g, " / ");
  }, scope);

async function modelInputState(page) {
  return page.evaluate((sel) => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    const input = [...document.querySelectorAll(sel)].find(vis);
    if (!input) return null;
    const boxes = {};
    for (const cb of document.querySelectorAll("[role=dialog] input[type=checkbox]")) {
      if (!vis(cb)) continue;
      const label = cb.getAttribute("aria-label");
      if (label) boxes[label] = cb.checked;
    }
    const eff = [...document.querySelectorAll("[data-testid=openrouter-effective-model]")].find(
      vis
    );
    return { value: input.value, boxes, effective: eff ? eff.innerText.trim() : null };
  }, MODEL_INPUT);
}

async function openSettings(panel, section) {
  await panel.evaluate((s) => window.electronAPI.openSettingsSection(s), section);
  await waitFor(() => panel.evaluate(() => Boolean(document.querySelector("[role=dialog]"))), {
    timeout: 10000,
    what: `settings dialog (${section})`,
  });
  await sleep(900);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function findForbidden(text) {
  const out = [];
  const re = new RegExp(FORBIDDEN_UI.source, "gi");
  let m;
  while ((m = re.exec(text)) && out.length < 4) {
    out.push(text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 70).trim());
  }
  return out;
}

async function scanAccountFree(panel, recorder) {
  const hits = [];
  const scanned = [];
  const scan = async (label, scope) => {
    const text = await visibleText(panel, scope);
    scanned.push(label);
    const found = findForbidden(text);
    if (found.length) hits.push({ view: label, found });
    return text;
  };

  await scan("home", null);
  // Sidebar destinations
  for (const item of [
    "Insights",
    "Chat",
    "Notes",
    "Upload",
    "Dictionary",
    "Integrations",
    "Home",
  ]) {
    await clickText(panel, item, null);
    await sleep(500);
    await scan(`sidebar:${item}`, null);
  }
  // Every settings section reachable from the nav
  await openSettings(panel, "speechToText");
  const nav = await panel.evaluate(() =>
    [...document.querySelectorAll("[role=dialog] button")]
      .map((b) => (b.innerText || "").trim())
      .filter((t) => t && t.length < 40)
  );
  const navLabels = nav.slice();
  const badNav = FORBIDDEN_NAV_LABELS.filter((l) => navLabels.includes(l));
  const sections = [
    "Preferences",
    "Hotkeys",
    "Tone & Style",
    "Speech-to-Text",
    "Language Models",
    "Privacy & Data",
    "System",
  ];
  const missing = [];
  for (const s of sections) {
    if (!navLabels.includes(s)) {
      missing.push(s);
      continue;
    }
    await clickText(panel, s);
    await sleep(500);
    await scan(`settings:${s}`, "[role=dialog]");
    if (s === "Privacy & Data" && process.env.OPENWHISPR_VERIFY_SCREENSHOTS) {
      await panel.screenshot({
        path: path.join(process.env.OPENWHISPR_VERIFY_SCREENSHOTS, "privacy.png"),
      });
    }
  }
  // Legacy account section ids must fall back to a personal section, never an account surface.
  const fallbacks = {};
  for (const id of ["account", "plansBilling", "workspace"]) {
    await openSettings(panel, id);
    const text = await visibleText(panel, "[role=dialog]");
    scanned.push(`openSettingsSection(${id})`);
    const found = findForbidden(text);
    if (found.length) hits.push({ view: `openSettingsSection(${id})`, found });
    fallbacks[id] = text.slice(0, 80);
  }
  let recorderText = "";
  if (recorder) {
    recorderText = await recorder.evaluate(() => document.body.innerText).catch(() => "");
    scanned.push("recorder");
    const found = findForbidden(recorderText);
    if (found.length) hits.push({ view: "recorder", found });
  }
  return { hits, scanned, badNav, missing, navLabels, fallbacks };
}

async function verifyRoundTrip(panel, label, expect) {
  // Re-open and read UI + storage back.
  const ls = await readLocal(panel);
  check(
    `${label}: localStorage.cloudTranscriptionProvider=openrouter`,
    ls.cloudTranscriptionProvider === "openrouter",
    ls.cloudTranscriptionProvider
  );
  check(
    `${label}: localStorage.cloudTranscriptionModel is the full id`,
    ls.cloudTranscriptionModel === MODEL_ID,
    ls.cloudTranscriptionModel
  );
  check(
    `${label}: localStorage.geminiSmartCleanup=${expect.gemini}`,
    ls.geminiSmartCleanup === expect.gemini,
    ls.geminiSmartCleanup
  );
  check(`${label}: cleanup model storage keeps the full id`, ls[expect.cleanupKey] === MODEL_ID, {
    key: expect.cleanupKey,
    value: ls[expect.cleanupKey],
  });
  check(
    `${label}: onboarding stays complete`,
    ls.onboardingCompleted === "true",
    ls.onboardingCompleted
  );

  // STT UI
  await openSettings(panel, "speechToText");
  await clickText(panel, "OpenRouter");
  const stt = await waitFor(() => modelInputState(panel), {
    timeout: 8000,
    what: "STT model input",
  });
  check(`${label}: STT field shows ${MODEL_ID}`, stt.value === MODEL_ID, stt.value);
  check(
    `${label}: STT Nitro routing checkbox reflects :nitro`,
    stt.boxes.Nitro === true && !stt.boxes.Floor && !stt.boxes.Exacto,
    stt.boxes
  );
  check(
    `${label}: STT effective request model unchanged`,
    stt.effective && stt.effective.includes(MODEL_ID),
    stt.effective
  );

  // Gemini toggle
  await clickText(panel, "Gemini");
  const gem = await panel.evaluate(() => {
    const el = document.querySelector('[role=dialog] input[aria-label="Gemini Smart cleanup"]');
    return el ? el.checked : null;
  });
  check(
    `${label}: Gemini Smart cleanup UI is ${expect.gemini === "true" ? "on" : "off"}`,
    gem === (expect.gemini === "true"),
    gem
  );

  // LLM UI
  await clickText(panel, "Language Models");
  await clickText(panel, "OpenRouter");
  const llm = await waitFor(() => modelInputState(panel), {
    timeout: 8000,
    what: "LLM model input",
  });
  check(`${label}: LLM cleanup field shows ${MODEL_ID}`, llm.value === MODEL_ID, llm.value);
  check(
    `${label}: LLM Nitro routing checkbox reflects :nitro`,
    llm.boxes.Nitro === true && !llm.boxes.Floor && !llm.boxes.Exacto,
    llm.boxes
  );
}

async function runInteractive(panel, recorder) {
  // ---- account-free surface -------------------------------------------------
  const acct = await scanAccountFree(panel, recorder);
  check(
    "account-free: no sign-in/upgrade/plans/workspace text in any reachable view",
    acct.hits.length === 0,
    acct.hits
  );
  check(
    "account-free: no Profile/Plans & Billing/Workspace/Account settings navigation",
    acct.badNav.length === 0,
    acct.badNav
  );
  check(
    "account-free: personal settings sections all present",
    acct.missing.length === 0,
    acct.missing
  );
  check(
    "account-free: legacy account/plansBilling/workspace section ids do not open account surfaces",
    Object.values(acct.fallbacks).every((t) => findForbidden(t).length === 0),
    acct.fallbacks
  );
  check(
    "account-free: onboarding bypass works and no sign-in gate blocks the panel",
    acct.scanned.includes("home"),
    acct.scanned.length
  );

  // ---- OpenRouter STT manual model ID --------------------------------------
  await openSettings(panel, "speechToText");
  await clickText(panel, "OpenRouter");
  await waitFor(() => modelInputState(panel), { timeout: 8000, what: "OpenRouter STT panel" });
  const before = await readLocal(panel);

  await replaceText(panel, MODEL_INPUT, MODEL_ID);
  let stt = await modelInputState(panel);
  let ls = await readLocal(panel);
  check("stt: manual model id typed into real input", stt.value === MODEL_ID, stt.value);
  check(
    "stt: Nitro suffix checkbox reflects the typed id",
    stt.boxes.Nitro === true && !stt.boxes.Floor && !stt.boxes.Exacto,
    stt.boxes
  );
  check(
    "stt: effective request model equals full typed id",
    stt.effective && stt.effective.includes(MODEL_ID),
    stt.effective
  );
  check(
    "stt: id persisted unchanged (no catalog allowlist)",
    ls.cloudTranscriptionModel === MODEL_ID && ls.cloudTranscriptionProvider === "openrouter",
    {
      model: ls.cloudTranscriptionModel,
      provider: ls.cloudTranscriptionProvider,
      before: before.cloudTranscriptionModel,
    }
  );

  // Edge inputs: unusual characters pass through unchanged, empty is accepted, neither crashes the UI.
  const edge = "vendor/ex\"'&<>\\ample:custom-suffix";
  await replaceText(panel, MODEL_INPUT, edge);
  stt = await modelInputState(panel);
  ls = await readLocal(panel);
  check(
    "stt edge: special characters and an unknown suffix are kept verbatim",
    stt.value === edge && ls.cloudTranscriptionModel === edge,
    { ui: stt.value, stored: ls.cloudTranscriptionModel }
  );
  await replaceText(panel, MODEL_INPUT, "");
  stt = await modelInputState(panel);
  check(
    "stt edge: empty value is accepted and the page stays responsive",
    stt && stt.value === "",
    stt && stt.value
  );
  await replaceText(panel, MODEL_INPUT, MODEL_ID);
  stt = await modelInputState(panel);
  ls = await readLocal(panel);
  check(
    "stt edge: recovery to the full id after edge inputs",
    stt.value === MODEL_ID && ls.cloudTranscriptionModel === MODEL_ID,
    { ui: stt.value, stored: ls.cloudTranscriptionModel }
  );

  // Synthetic catalog refresh must not overwrite the manual selection.

  const fixtureBefore =
    ledger.expected_offline.fixture_served.get(
      "GET openrouter.ai/api/v1/models?output_modalities=transcription"
    ) || 0;
  await clickText(panel, "Refresh");
  await waitFor(async () => (await panel.getByText(FIXTURE_NAME, { exact: true }).count()) > 0, {
    timeout: 10000,
    what: "synthetic transcription catalog rendered",
  }).then(
    () => check("stt: synthetic catalog fixture was fetched and rendered by the real UI", true),
    (e) =>
      check(
        "stt: synthetic catalog fixture was fetched and rendered by the real UI",
        false,
        e.message
      )
  );
  const fixtureAfter =
    ledger.expected_offline.fixture_served.get(
      "GET openrouter.ai/api/v1/models?output_modalities=transcription"
    ) || 0;
  check(
    "stt: refresh issued a transcription-scoped catalog request",
    fixtureAfter > fixtureBefore,
    { before: fixtureBefore, after: fixtureAfter }
  );
  stt = await modelInputState(panel);
  ls = await readLocal(panel);
  check(
    "stt: manual id survives catalog refresh",
    stt.value === MODEL_ID && ls.cloudTranscriptionModel === MODEL_ID,
    { ui: stt.value, stored: ls.cloudTranscriptionModel }
  );

  // ---- Gemini Smart cleanup -------------------------------------------------
  await clickText(panel, "Gemini");
  const geminiSel = '[role=dialog] input[aria-label="Gemini Smart cleanup"]';
  const gemDefault = await panel.evaluate((s) => {
    const e = document.querySelector(s);
    return e ? e.checked : null;
  }, geminiSel);
  check(
    "gemini: Smart cleanup toggle is visible and defaults off",
    gemDefault === false,
    gemDefault
  );
  ls = await readLocal(panel);
  check(
    "gemini: browsing the Gemini tab does not change the selected STT provider/model",
    ls.cloudTranscriptionProvider === "openrouter" && ls.cloudTranscriptionModel === MODEL_ID,
    {
      provider: ls.cloudTranscriptionProvider,
      model: ls.cloudTranscriptionModel,
    }
  );
  await clickSelector(panel, geminiSel);
  const gemOn = await panel.evaluate((s) => document.querySelector(s).checked, geminiSel);
  ls = await readLocal(panel);
  check("gemini: Smart cleanup toggles on via pointer click", gemOn === true, gemOn);
  check(
    'gemini: Smart cleanup stored as "true"',
    ls.geminiSmartCleanup === "true",
    ls.geminiSmartCleanup
  );

  // Return to OpenRouter tab: the manual id must still be in the field.
  await clickText(panel, "OpenRouter");
  stt = await waitFor(() => modelInputState(panel), {
    timeout: 8000,
    what: "OpenRouter STT panel (return)",
  });
  check("stt: manual id survives provider-tab switching", stt.value === MODEL_ID, stt.value);

  // ---- OpenRouter LLM cleanup manual model ID ------------------------------
  const lsBeforeLlm = await readLocal(panel);
  await clickText(panel, "Language Models");
  await clickText(panel, "OpenRouter");
  await waitFor(() => modelInputState(panel), { timeout: 8000, what: "OpenRouter LLM panel" });
  await replaceText(panel, MODEL_INPUT, MODEL_ID);
  const llm = await modelInputState(panel);
  const lsAfterLlm = await readLocal(panel);
  check("llm: manual cleanup model id typed into real input", llm.value === MODEL_ID, llm.value);
  check(
    "llm: Nitro suffix checkbox reflects the typed id",
    llm.boxes.Nitro === true && !llm.boxes.Floor && !llm.boxes.Exacto,
    llm.boxes
  );
  check(
    "llm: effective request model equals full typed id",
    llm.effective && llm.effective.includes(MODEL_ID),
    llm.effective
  );
  const changedKeys = Object.keys(lsAfterLlm).filter((k) => lsAfterLlm[k] !== lsBeforeLlm[k]);
  const cleanupKey = changedKeys.find((k) => lsAfterLlm[k] === MODEL_ID);
  check("llm: id persisted unchanged under a settings key", Boolean(cleanupKey), { changedKeys });
  const fxLlmBefore =
    ledger.expected_offline.fixture_served.get(
      "GET openrouter.ai/api/v1/models?output_modalities=text"
    ) || 0;
  await clickText(panel, "Refresh");
  await waitFor(async () => (await panel.getByText(FIXTURE_NAME, { exact: true }).count()) > 0, {
    timeout: 10000,
    what: "synthetic text catalog rendered",
  }).then(
    () => check("llm: synthetic catalog fixture was fetched and rendered by the real UI", true),
    (e) =>
      check(
        "llm: synthetic catalog fixture was fetched and rendered by the real UI",
        false,
        e.message
      )
  );
  const fxLlmAfter =
    ledger.expected_offline.fixture_served.get(
      "GET openrouter.ai/api/v1/models?output_modalities=text"
    ) || 0;
  check("llm: refresh issued a text-scoped catalog request", fxLlmAfter > fxLlmBefore, {
    before: fxLlmBefore,
    after: fxLlmAfter,
  });
  const llmAfter = await modelInputState(panel);
  const lsFinal = await readLocal(panel);
  check(
    "llm: manual id survives catalog refresh",
    llmAfter.value === MODEL_ID && lsFinal[cleanupKey] === MODEL_ID,
    { ui: llmAfter.value, stored: cleanupKey && lsFinal[cleanupKey] }
  );

  if (process.env.OPENWHISPR_VERIFY_SCREENSHOTS) {
    await panel.screenshot({
      path: path.join(process.env.OPENWHISPR_VERIFY_SCREENSHOTS, "openrouter.png"),
    });
  }
  return { cleanupKey: cleanupKey || "unknown" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform === "linux" && process.env.OPENWHISPR_VERIFY_XVFB !== "1") {
    wrapUnderXvfb();
    return;
  }

  const result = {
    ok: false,
    tool: "verify-personal-fork",
    repo: REPO,
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
    scope:
      "real built Electron app, headless Xvfb, isolated profile, no network, UI behaviour only",
  };
  let root = null;
  let session = null;
  let catalog = null;
  let finished = false;

  const finish = async (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    try {
      await stopApp(session, { graceful: false });
    } catch {
      /* best effort */
    }
    killOwned("SIGKILL");
    if (catalog) {
      catalog.server.closeAllConnections();
      await new Promise((resolve) => catalog.server.close(resolve));
    }
    if (root) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    result.duration_s = elapsed();
    emit(result, code);
  };

  const watchdog = setTimeout(() => {
    check("completed within time budget", false, `${INNER_BUDGET_MS}ms exceeded in phase ${phase}`);
    result.error = `watchdog: phase ${phase}`;
    summarize();
    finish(1);
  }, INNER_BUDGET_MS);

  const realConfigSnapshot = () => {
    const out = {};
    const home = os.homedir();
    const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    for (const n of ["OpenWhispr", "OpenWhispr-development", "OpenWhispr-staging"]) {
      try {
        out[n] = fs.statSync(path.join(base, n)).mtimeMs;
      } catch {
        out[n] = null;
      }
    }
    return out;
  };

  function summarize() {
    const toList = (m) => [...m.entries()].map(([k, v]) => ({ url: k, count: v }));
    const unexpectedCount = Object.values(ledger.unexpected).reduce((n, a) => n + a.length, 0);
    result.checks = {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
    };
    result.all_checks = checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`);
    result.console = {
      monitoring:
        "playwright-core over loopback CDP, attached before the first window was created; console/pageerror/requestfailed/response/crash on every page",
      unexpected: ledger.unexpected,
      unexpected_count: unexpectedCount,
      warnings_ignored: ledger.console_warning_count,
      other_messages: ledger.console_other_count,
    };
    result.network = {
      policy:
        "deny-by-default: all remote http(s) renderer requests aborted; Chromium DNS blocked; no credentials entered",
      expected_offline_blocked: toList(ledger.expected_offline.blocked_requests),
      synthetic_catalog_fixture_served: toList(ledger.expected_offline.fixture_served),
      synthetic_catalog_label: SYNTHETIC_LABEL,
    };
    result.pages_seen = [...ledger.pages_seen];
    result.preexisting_pages_before_monitoring = ledger.preexisting_pages;
    result.coverage_gaps = COVERAGE_GAPS;
    const monitoringGap = ledger.preexisting_pages.length > 0;
    if (monitoringGap)
      result.coverage_gaps = [
        ...COVERAGE_GAPS,
        "Some windows existed before monitoring attached; their initial load was not observed.",
      ];
    result.ok =
      checks.length > 0 && checks.every((c) => c.ok) && unexpectedCount === 0 && !monitoringGap;
  }

  try {
    // ---- preconditions (blockers, not failures) -----------------------------
    let playwright;
    try {
      playwright = require(process.env.PLAYWRIGHT_CORE_PATH || "playwright-core");
    } catch (e) {
      result.blocker = `playwright-core not resolvable (set NODE_PATH or PLAYWRIGHT_CORE_PATH to a tooling dir): ${e.message.split("\n")[0]}`;
      return finish(2);
    }
    let electronBin;
    try {
      electronBin = require(path.join(REPO, "node_modules", "electron"));
      if (typeof electronBin !== "string" || !fs.existsSync(electronBin))
        throw new Error("electron binary missing (run npm ci)");
    } catch (e) {
      result.blocker = `electron dependency not usable: ${e.message}`;
      return finish(2);
    }
    if (!fs.existsSync(path.join(REPO, "src", "dist", "index.html"))) {
      result.blocker =
        "compiled renderer missing: run `npm run build:renderer` first (src/dist/index.html)";
      return finish(2);
    }
    if (!process.env.DISPLAY) {
      result.blocker =
        "no DISPLAY: run under xvfb-run or let this script wrap itself (do not set OPENWHISPR_VERIFY_XVFB without a display)";
      return finish(2);
    }
    try {
      result.runtime.electron = JSON.parse(
        fs.readFileSync(path.join(REPO, "node_modules", "electron", "package.json"), "utf8")
      ).version;
      result.runtime.playwright_core = require(
        path.join(
          path.dirname(require.resolve(process.env.PLAYWRIGHT_CORE_PATH || "playwright-core")),
          "package.json"
        )
      ).version;
    } catch {
      /* informational only */
    }

    root = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-verify-"));
    const { env, dirs } = makeIsolatedEnv(root, process.env.DISPLAY);
    catalog = await startCatalogServer(root);
    const ctxInfo = { root, env, dirs, electronBin, catalog };
    const configBefore = realConfigSnapshot();
    result.isolation = {
      profile_root: "mkdtemp under os.tmpdir() (removed afterwards)",
      home_xdg_userdata_overridden: true,
      session_bus_and_tokens_forwarded: false,
      loopback_cdp_only: true,
    };

    // ---- run 1: fresh profile, seeded only with onboardingCompleted ---------
    phase = "launch-1";
    log("launching run 1 (fresh isolated profile)");
    session = await launchApp(playwright, ctxInfo, { seed: true });
    let panel = await findPanel(session);
    const recorder = await findRecorder(session).catch(() => null);
    phase = "interactive";
    const { cleanupKey } = await runInteractive(panel, recorder);
    const profileDirs = fs.readdirSync(dirs.config).filter((n) => /^OpenWhispr/.test(n));
    const profileFiles = profileDirs.flatMap((n) => fs.readdirSync(path.join(dirs.config, n)));
    check(
      "isolation: app profile (Local Storage etc.) was created inside the throw-away XDG config",
      profileFiles.length > 0,
      { dirs: profileDirs, entries: profileFiles.length }
    );

    // ---- persistence across renderer reload ----------------------------------
    phase = "reload";
    await panel.reload({ waitUntil: "domcontentloaded" });
    panel = await findPanel(session);
    await verifyRoundTrip(panel, "after reload", { gemini: "true", cleanupKey });

    // ---- persistence across a real application restart -----------------------
    phase = "restart";
    const stopped = await stopApp(session, { graceful: true });
    check("restart: app exited on SIGTERM so storage is flushed", stopped.graceful, stopped);
    log("relaunching run 2 (same profile, no seeding)");
    phase = "launch-2";
    session = await launchApp(playwright, ctxInfo, { seed: false });
    panel = await findPanel(session);
    phase = "verify-2";
    const ls2 = await readLocal(panel);
    check(
      "restart: onboarding persisted without reseeding (no onboarding gate)",
      ls2.onboardingCompleted === "true",
      ls2.onboardingCompleted
    );
    await verifyRoundTrip(panel, "after restart", { gemini: "true", cleanupKey });

    // Turn Smart cleanup off again and prove the "off" state also round-trips through a reload.
    phase = "gemini-off";
    await openSettings(panel, "speechToText");
    await clickText(panel, "Gemini");
    await clickSelector(panel, '[role=dialog] input[aria-label="Gemini Smart cleanup"]');
    const offStored = (await readLocal(panel)).geminiSmartCleanup;
    check(
      'gemini: Smart cleanup toggles back off and stores "false"',
      offStored === "false",
      offStored
    );
    await panel.reload({ waitUntil: "domcontentloaded" });
    panel = await findPanel(session);
    const offAfterReload = (await readLocal(panel)).geminiSmartCleanup;
    check("gemini: off state persists across reload", offAfterReload === "false", offAfterReload);

    const configAfter = realConfigSnapshot();
    check(
      "isolation: real user config dirs untouched",
      JSON.stringify(configBefore) === JSON.stringify(configAfter),
      { before: configBefore, after: configAfter }
    );

    phase = "done";
    check(
      "process: no electron stderr crash signature",
      !/FATAL|Segmentation fault|renderer process gone/i.test(
        fs.readFileSync(session.logFile, "utf8")
      ),
      session.logFile.replace(root, "<root>")
    );
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err)
      .split("\n")
      .slice(0, 6)
      .join(" | ");
    check(`harness completed (phase ${phase})`, false, result.error);
  }

  if (result.blocker) return finish(2);
  summarize();
  return finish(result.ok ? 0 : 1);
}

process.on("unhandledRejection", (e) => {
  log("unhandledRejection", String(e && e.stack ? e.stack : e));
});

main().catch((e) => {
  process.stderr.write(`fatal: ${e && e.stack ? e.stack : e}\n`);
  killOwned("SIGKILL");
  emit({ ok: false, error: String(e && e.message) }, 1);
});
