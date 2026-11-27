const processListCache = require("./processListCache");
const { isBrowserSignature } = require("./toneAppCategories");

// Calling apps and the system processes calls run in, by whole token of the
// capture app's id: zoom.us / CptHost, Microsoft Teams / ms-teams_modulehost,
// Webex, FaceTime's avconferenced and callservicesd, Slack huddles, Discord,
// and WebKit's GPU process, which captures for Safari and every WKWebView app.
const CALLING_APP_ID =
  /(?:^|[^a-z0-9])(?:zoom|cpthost|teams|webex|webexmeetingsapp|facetime|avconferenced|callservicesd|slack|discord|webkit)(?:$|[^a-z0-9])/;

// The app behind a microphone capture, as the meeting prompt names it and the
// ignore list stores it. macOS reports the process that opened the input, often
// a helper inside the app's bundle (Chromium, Electron), so the outermost bundle
// names the app there.
function captureAppFromProcess({ name, path }, platform = process.platform) {
  // ps-list leaves `path` empty for an executable path with many spaces (Chrome's
  // helpers) and reports the whole path as `name` instead.
  const executable = path || name || "";
  if (platform === "darwin") {
    const bundle = /\/([^/]+)\.app(?:\/|$)/.exec(executable);
    if (bundle) return { id: bundle[1].toLowerCase(), name: bundle[1] };
  }
  const fileName = executable.split(/[\\/]/).pop();
  if (!fileName) return null;
  return {
    id: fileName.toLowerCase(),
    name: platform === "win32" ? fileName.replace(/\.exe$/i, "") : fileName,
  };
}

// The card never offers to ignore a browser or a calling app: the id covers the
// whole app, so one false alarm would silence every real meeting held in it.
function isIgnorableCaptureApp({ id }) {
  return !isBrowserSignature(id) && !CALLING_APP_ID.test(id);
}

async function resolveCaptureApps(pids) {
  // Windows reports a session it can't attribute to one process as pid 0, which
  // the process list names "[System Process]": no app to name or ignore.
  const attributable = pids.filter((pid) => pid > 0);
  if (!attributable.length) return new Map();
  let processes = await processListCache.getProcesses();
  // Chromium starts its audio service on demand, so the capturing process can
  // be younger than the cached listing.
  if (attributable.some((pid) => !processes.some((proc) => proc.pid === pid))) {
    processListCache.invalidate();
    processes = await processListCache.getProcesses();
  }
  const apps = new Map();
  for (const proc of processes) {
    if (!attributable.includes(proc.pid)) continue;
    const app = captureAppFromProcess(proc);
    if (app) apps.set(proc.pid, app);
  }
  return apps;
}

module.exports = { captureAppFromProcess, isIgnorableCaptureApp, resolveCaptureApps };
