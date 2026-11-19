// Launch at login, elevated, on Windows. Mirrors linuxAutostart.js: a platform where
// setLoginItemSettings() cannot express what is needed, so a bespoke mechanism sits
// behind the same autoStart.js interface.
//
// Why a scheduled task rather than the Run entry: Explorer starts Run entries with the
// user's filtered (medium-integrity) token, and no flag changes that. Windows blocks
// synthetic input from a lower-integrity process into a higher-integrity window (UIPI)
// and reports nothing to the sender, so an unelevated OpenWhispr silently discards
// every dictation aimed at an administrator window. A task with RunLevel=Highest is the
// only way to start elevated at login WITHOUT a UAC prompt every time: Task Scheduler
// already runs as SYSTEM and mints the token itself instead of requesting elevation.
//
// Creating or deleting the task needs administrator rights once, which is the single
// UAC prompt the user sees when they flip the switch.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { HIDDEN_LAUNCH_FLAG } = require("./autoStartPolicy");

// Task names are machine-global, so scope it to the account it launches for. Two users
// on one machine would otherwise fight over a single task with one UserId.
function getTaskName(username = os.userInfo().username) {
  return `OpenWhispr Launch At Login (${username})`;
}

const SCHTASKS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
const TIMEOUT_MS = 20000;

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// LogonType=InteractiveToken is load-bearing: it keeps the process in the user's
// interactive session. Password/S4U run it non-interactively with no desktop, where a
// GUI app has no foreground window to type into and no user-session audio endpoint.
//
// ExecutionTimeLimit must be PT0S. The default is PT72H, which would have Task
// Scheduler kill a tray app after three days for no visible reason.
// DisallowStartIfOnBatteries defaults to true, which would silently skip autostart on
// battery power.
function buildTaskXml({ userId, execPath, args = [HIDDEN_LAUNCH_FLAG] }) {
  const argumentsLine = args.length
    ? `\n      <Arguments>${xmlEscape(args.join(" "))}</Arguments>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts OpenWhispr elevated at log on so dictation can reach windows running as administrator.</Description>
    <URI>\\${xmlEscape(getTaskName())}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(execPath)}</Command>${argumentsLine}
    </Exec>
  </Actions>
</Task>
`;
}

// Querying needs no elevation.
function isEnabled(taskName = getTaskName()) {
  if (process.platform !== "win32") return false;
  try {
    const result = spawnSync(SCHTASKS, ["/Query", "/TN", taskName], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// schtasks /XML rejects UTF-8: the file has to be UTF-16LE with a BOM, matching the
// encoding declared in the XML prolog.
function writeTaskXmlFile(xml) {
  const file = path.join(os.tmpdir(), `openwhispr-autostart-${process.pid}-${Date.now()}.xml`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  return file;
}

// Runs schtasks elevated via ShellExecute's runas verb, which is the one UAC prompt.
// -Wait so the caller can report a real result instead of an optimistic one; a user who
// dismisses the prompt produces a non-zero exit, which surfaces as a failure.
function runElevated(args) {
  const quoted = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
  const script = `$p = Start-Process -FilePath '${SCHTASKS.replace(/'/g, "''")}' -ArgumentList ${quoted} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    }
  );
  return { ok: result.status === 0, status: result.status, stderr: result.stderr || "" };
}

function enable({ execPath = process.execPath, args = [HIDDEN_LAUNCH_FLAG] } = {}) {
  if (process.platform !== "win32") return { ok: false, reason: "unsupported-platform" };
  const taskName = getTaskName();
  const userId = `${os.hostname()}\\${os.userInfo().username}`;
  const xmlFile = writeTaskXmlFile(buildTaskXml({ userId, execPath, args }));
  try {
    const result = runElevated(["/Create", "/TN", taskName, "/XML", xmlFile, "/F"]);
    if (!result.ok)
      return { ok: false, reason: "elevation-declined-or-failed", detail: result.stderr };
    return { ok: true };
  } finally {
    try {
      fs.unlinkSync(xmlFile);
    } catch {
      /* the temp file is best-effort */
    }
  }
}

function disable() {
  if (process.platform !== "win32") return { ok: false, reason: "unsupported-platform" };
  if (!isEnabled()) return { ok: true };
  const result = runElevated(["/Delete", "/TN", getTaskName(), "/F"]);
  if (!result.ok)
    return { ok: false, reason: "elevation-declined-or-failed", detail: result.stderr };
  return { ok: true };
}

module.exports = {
  getTaskName,
  buildTaskXml,
  isEnabled,
  enable,
  disable,
};
