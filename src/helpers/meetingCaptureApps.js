const processListCache = require("./processListCache");

// The app behind a microphone capture, as the meeting prompt names it and the
// ignore list stores it. macOS reports the process that opened the input, often
// a helper inside the app's bundle (Chromium, Electron), so the outermost bundle
// names the app there.
function captureAppFromProcess({ name, path }, platform = process.platform) {
  if (platform === "darwin") {
    const bundle = /\/([^/]+)\.app(?:\/|$)/.exec(path || "");
    if (bundle) return { id: bundle[1].toLowerCase(), name: bundle[1] };
  }
  if (!name) return null;
  return {
    id: name.toLowerCase(),
    name: platform === "win32" ? name.replace(/\.exe$/i, "") : name,
  };
}

async function resolveCaptureApps(pids) {
  let processes = await processListCache.getProcesses();
  // Chromium starts its audio service on demand, so the capturing process can
  // be younger than the cached listing.
  if (pids.some((pid) => !processes.some((proc) => proc.pid === pid))) {
    processListCache.invalidate();
    processes = await processListCache.getProcesses();
  }
  const apps = new Map();
  for (const proc of processes) {
    if (!pids.includes(proc.pid)) continue;
    const app = captureAppFromProcess(proc);
    if (app) apps.set(proc.pid, app);
  }
  return apps;
}

module.exports = { captureAppFromProcess, resolveCaptureApps };
