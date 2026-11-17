const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const execFileAsync = promisify(require("node:child_process").execFile);

const BOOTSTRAP_NAME = "enterprise-audio-bootstrap.json";

const bootstrapError = (code, messageKey, message) =>
  Object.assign(new Error(message), { code, messageKey });
const notProtected = (message) =>
  bootstrapError("BOOTSTRAP_NOT_PROTECTED", "enterprise.audio.bootstrapNotProtected", message);

// The owner must be the current user, and no Allow ACE may grant ReadData to
// anyone but that user, SYSTEM or Administrators. The path travels in the
// environment, so no quoting of it reaches the script.
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:OW_BOOTSTRAP_PATH
$sid = [System.Security.Principal.SecurityIdentifier]
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($acl.GetOwner($sid).Value -ne $me) { exit 1 }
$allowed = @($me, 'S-1-5-18', 'S-1-5-32-544')
$read = [System.Security.AccessControl.FileSystemRights]::ReadData
foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
  if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $read) -and $rule.IdentityReference.Value -notin $allowed) { exit 1 }
}
exit 0`;

async function assertProtectedBootstrap(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
    throw notProtected("Enterprise bootstrap must be a regular file under 512 KiB");
  if (process.platform !== "win32") {
    // The app runs as the signed-in user, so a root-owned 0600 file could never be read.
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
      throw notProtected(
        "Enterprise bootstrap must be owned by the signed-in user and readable only by that user"
      );
  } else {
    try {
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
        ],
        { windowsHide: true, env: { ...process.env, OW_BOOTSTRAP_PATH: file } }
      );
    } catch {
      throw notProtected(
        "Enterprise bootstrap must be owned by the signed-in user and readable only by that user"
      );
    }
  }
  // Checked before the claim, so an unreadable delivery is never renamed away.
  try {
    await fs.access(file, fs.constants.R_OK);
  } catch {
    throw bootstrapError(
      "BOOTSTRAP_UNREADABLE",
      "enterprise.audio.bootstrapUnreadable",
      "Enterprise bootstrap is not readable by the signed-in user"
    );
  }
}

async function importEnterpriseAudioBootstrap({
  directory,
  accountId,
  workspaceId,
  allowedSlots,
  credentials,
}) {
  const source = path.join(directory, BOOTSTRAP_NAME);
  try {
    await assertProtectedBootstrap(source);
  } catch (error) {
    if (error.code === "ENOENT") return { imported: false };
    throw error;
  }
  const claimed = `${source}.${randomUUID()}.importing`;
  await fs.rename(source, claimed);
  try {
    const data = JSON.parse(await fs.readFile(claimed, "utf8"));
    if (
      data.version !== 1 ||
      data.accountId !== accountId ||
      data.workspaceId !== workspaceId ||
      Object.keys(data).some(
        (key) => !["version", "accountId", "workspaceId", "credentials"].includes(key)
      ) ||
      !data.credentials ||
      typeof data.credentials !== "object" ||
      Array.isArray(data.credentials) ||
      Object.keys(data.credentials).some((slot) => !allowedSlots.includes(slot))
    )
      throw bootstrapError(
        "BOOTSTRAP_MISMATCH",
        "enterprise.audio.bootstrapMismatch",
        "Enterprise bootstrap does not match the signed-in account, workspace or configured slots"
      );
    await credentials.saveMany(accountId, workspaceId, data.credentials);
    await fs.rm(claimed);
    return { imported: true };
  } catch (error) {
    // Restore without overwriting a newer MDM delivery; a claim that can't be
    // restored is deleted, never kept as plaintext. No plaintext reaches logs.
    await fs.link(claimed, source).catch(() => {});
    await fs.rm(claimed, { force: true }).catch(() => {});
    throw error;
  }
}

// Claims an interrupted import left behind; Reset app data removes them.
async function removeClaimedBootstraps(directory) {
  const names = await fs.readdir(directory).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${BOOTSTRAP_NAME}.`) && name.endsWith(".importing"))
      .map((name) => fs.rm(path.join(directory, name), { force: true }))
  );
}

module.exports = {
  assertProtectedBootstrap,
  importEnterpriseAudioBootstrap,
  removeClaimedBootstraps,
};
