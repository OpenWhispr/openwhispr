const path = require("node:path");
const { parseDn } = require("builder-util-runtime");

const MICROSOFT_PUBLISHER = "O=Microsoft Corporation, C=US";
const NATIVE_EXTENSIONS = new Set([".dll", ".node"]);

const VERIFY_SIGNATURES = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$signTool = (Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1).Source
if (-not $signTool) {
  $sdkBin = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Windows Kits\10\bin'
  $signTool = Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction SilentlyContinue |
    Where-Object Name -Match '^\d+\.\d+\.\d+\.\d+$' |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
}
if (-not $signTool) { throw 'Windows SDK SignTool is required to verify release signatures.' }

$report = foreach ($binary in Get-ChildItem -LiteralPath $root -Recurse -Force -File) {
  if ($binary.Extension -notin $extensions) { continue }
  $relativePath = $binary.FullName.Substring($root.Length + 1)
  # Without catalog options SignTool checks the embedded signature. Exit 2
  # includes a missing timestamp and must fail verification.
  $ErrorActionPreference = 'Continue'
  $LASTEXITCODE = 1
  $diagnostic = & $signTool verify /pa /tw $binary.FullName 2>&1
  $verificationStatus = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($verificationStatus -ne 0) {
    @{
      file = $relativePath
      error = "SignTool exited with $verificationStatus - " + ($diagnostic -join ' ').Trim()
    }
    continue
  }

  # Read the publisher from the verified embedded signature, independent of
  # the host's catalog database.
  $certificate = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($binary.FullName)
  @{ file = $relativePath; publisher = $certificate.Subject }
}

ConvertTo-Json -InputObject @($report) -Compress
`;

function isSignedWindowsBuild(context) {
  return context.electronPlatformName === "win32" && context.packager.forceCodeSigning;
}

async function inspectWindowsSignatures(context, nativeOnly = false) {
  const vm = await context.packager.vm.value;
  const powershell = await vm.powershellCommand.value;
  const root = vm.toVmFile(context.appOutDir).replace(/'/g, "''");
  const extensions = nativeOnly ? "'.dll', '.node'" : "'.exe', '.dll', '.node'";
  const command = `$root = (Get-Item -LiteralPath '${root}').FullName.TrimEnd([char]92); $extensions = ${extensions}; ${VERIFY_SIGNATURES}`;
  const output = await vm.exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    timeout: 300_000,
  });
  return JSON.parse(output);
}

function publisherMatches(publisher, expected) {
  const actual = parseDn(publisher);
  const expectedFields = parseDn(expected);
  if (expectedFields.size === 0) return actual.get("CN") === expected;
  return [...expectedFields].every(([attribute, value]) => {
    if (attribute === "S" || attribute === "ST") {
      return (actual.get("S") ?? actual.get("ST")) === value;
    }
    return actual.get(attribute) === value;
  });
}

function isApprovedSignature({ file, publisher, error }, packager) {
  if (error || !publisher) return false;
  const { azureSignOptions, signtoolOptions } = packager.platformSpecificBuildOptions;
  const configured = azureSignOptions?.publisherName ?? signtoolOptions?.publisherName;
  const releasePublishers = [configured].flat().filter(Boolean);
  return (
    releasePublishers.some((expected) => publisherMatches(publisher, expected)) ||
    (NATIVE_EXTENSIONS.has(path.extname(file).toLowerCase()) &&
      publisherMatches(publisher, MICROSOFT_PUBLISHER))
  );
}

async function signWindowsNativeModules(context) {
  if (!isSignedWindowsBuild(context)) return;

  const report = await inspectWindowsSignatures(context, true);
  for (const signature of report) {
    if (isApprovedSignature(signature, context.packager)) continue;
    const file = path.join(context.appOutDir, ...signature.file.split("\\"));
    // Without win.signExts the builder keeps its normal .exe signing pass,
    // and signIf can explicitly sign any native module that needs it.
    if (!(await context.packager.signIf(file))) {
      throw new Error(`afterPack: could not sign ${signature.file}`);
    }
  }
}

module.exports = {
  inspectWindowsSignatures,
  isApprovedSignature,
  isSignedWindowsBuild,
  signWindowsNativeModules,
};
