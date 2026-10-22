// Peak memory of the engine processes the exam starts: pgrep and ps on macOS
// and Linux, one PowerShell process query on Windows.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function childPids() {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(process.pid)]);
    return stdout.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function processName(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", String(pid)]);
    return stdout.trim().split("/").pop();
  } catch {
    return null;
  }
}

function parseKiB(value) {
  const match = /([\d.]+)\s*([KMG])/i.exec(value || "");
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toUpperCase();
  return unit === "G" ? n * 1024 * 1024 : unit === "M" ? n * 1024 : n;
}

async function peakMiB(pid) {
  const { stdout: rssOut } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  const rssMiB = Number(rssOut.trim()) / 1024;
  if (process.platform !== "darwin") return rssMiB;
  // On macOS `vmmap -summary` reports the peak physical footprint, which on
  // Apple silicon includes memory used on the graphics chip. It leaves out
  // model files memory-mapped from disk, which llama.cpp and sherpa-onnx use;
  // resident size counts those pages, so the larger of the two is what the
  // machine actually has to hold.
  const { stdout } = await execFileAsync("vmmap", ["-summary", String(pid)], {
    maxBuffer: 1024 * 1024 * 32,
  });
  const now = parseKiB(/Physical footprint:\s+(\S+)/.exec(stdout)?.[1]);
  const peak = parseKiB(/Physical footprint \(peak\):\s+(\S+)/.exec(stdout)?.[1]);
  return Math.max((peak ?? now) / 1024, rssMiB);
}

const ENGINE = /whisper-server|sherpa-onnx|llama-server/;

// Windows reports the peak working set in KiB and the current one in bytes.
async function windowsEnginePeaks() {
  const query =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ` +
    "Select-Object Name, PeakWorkingSetSize, WorkingSetSize | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
  const peaks = {};
  for (const row of stdout.trim() ? [JSON.parse(stdout)].flat() : []) {
    if (!ENGINE.test(row.Name)) continue;
    const mib = Math.max(row.PeakWorkingSetSize / 1024, row.WorkingSetSize / 2 ** 20);
    peaks[row.Name] = Math.max(peaks[row.Name] || 0, mib);
  }
  return peaks;
}

// Peak memory of every engine process currently running under this script.
export async function enginePeaks() {
  if (process.platform === "win32") return windowsEnginePeaks();
  const peaks = {};
  for (const pid of await childPids()) {
    const name = await processName(pid);
    if (!name || !ENGINE.test(name)) continue;
    try {
      peaks[name] = Math.max(peaks[name] || 0, await peakMiB(pid));
    } catch {
      // The process exited between listing and reading it.
    }
  }
  return peaks;
}
