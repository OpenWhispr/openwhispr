const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

async function assertProtectedBootstrap(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
    throw new Error("Enterprise bootstrap must be a regular file under 512 KiB");
  if (process.platform !== "win32") {
    if ((stat.mode & 0o077) !== 0 || (stat.uid !== process.getuid() && stat.uid !== 0))
      throw new Error(
        "Enterprise bootstrap must be owned by the current user or root and readable only by its owner"
      );
  } else {
    const literal = file.replace(/'/g, "''");
    const script = `$bad = @('S-1-1-0','S-1-5-11','S-1-5-32-545'); $broad = (Get-Acl -LiteralPath '${literal}').Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -in $bad -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) }; if ($broad) { exit 1 }`;
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "ignore" }
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
  const source = path.join(directory, "enterprise-audio-bootstrap.json");
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
      throw new Error(
        "Enterprise bootstrap does not match the signed-in account, workspace or configured slots"
      );
    await credentials.saveMany(accountId, workspaceId, data.credentials);
    await fs.rm(claimed);
    return { imported: true };
  } catch (error) {
    // Restore without overwriting a newer MDM delivery. No plaintext reaches logs.
    try {
      await fs.link(claimed, source);
      await fs.rm(claimed);
    } catch {}
    throw error;
  }
}

module.exports = { assertProtectedBootstrap, importEnterpriseAudioBootstrap };
