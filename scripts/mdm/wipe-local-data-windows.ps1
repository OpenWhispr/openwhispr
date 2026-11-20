# Removes OpenWhispr's local data from a Windows device being offboarded
# (#3030), for MDM tools that run scripts as SYSTEM (Intune). A profile whose
# user is signed in, the only way OpenWhispr can be running in it, is skipped.
# The WipeLocalDataOnLaunch device key does the same from inside the app.
#
#   wipe-local-data-windows.ps1 [-IncludeModels] [-UserProfile C:\Users\name, ...]
#
# Covers every user profile unless profiles are named. Downloaded models stay
# unless -IncludeModels is passed. The audit log stays, as does the record of
# the last WipeLocalDataOnLaunch token, so the app doesn't wipe a second time,
# and each profile's wipe is recorded there.
# See docs/mdm-local-data-wipe.md.

param(
  [switch]$IncludeModels,
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string[]]$UserProfile
)

$ErrorActionPreference = "Stop"

# The same lists as KEPT_USER_DATA_ENTRIES, MODEL_USER_DATA_ENTRIES,
# MODEL_CACHE_ENTRIES and TEMP_PREFIXES in src/helpers/localDataWipe.js.
$keptUserData = @("audit", "meeting-audit-session.json", "meeting-audit-session.json.tmp", "local-data-wipe.json", "globe-preference-state.json")
$modelUserData = @("installed-models.json")
$modelCache = @("whisper-models", "parakeet-models", "diarization-models", "models", "whisper-vad", "embedding-models")
$tempPrefixes = @("ow-", "openwhispr-", "whisper-input-", "whisper-output-", "parakeet-", "enterprise-buffer-", "enterprise-chunks-", "kwin-active-class-")

# Whether Path is inside Root with no junction or symbolic link on the way:
# running as SYSTEM, a link a user made must never lead the script elsewhere.
function Test-RealFolder([string]$Path, [string]$Root) {
  $full = [IO.Path]::GetFullPath($Path)
  $top = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not $full.StartsWith("$top\", [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
  if (-not ($item -is [IO.DirectoryInfo])) { return $false }
  while ($item -and $item.FullName.TrimEnd("\").Length -gt $top.Length) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    $item = $item.Parent
  }
  return $true
}

# Deletes a file or folder tree, read-only files included. A junction or link
# is removed itself, never what it points to (Windows PowerShell's
# Remove-Item -Recurse can follow one).
function Remove-Tree([IO.FileSystemInfo]$Item) {
  $isLink = $Item.Attributes -band [IO.FileAttributes]::ReparsePoint
  if ($Item -is [IO.DirectoryInfo] -and -not $isLink) {
    foreach ($child in $Item.GetFileSystemInfos()) { Remove-Entry $child }
  }
  if ($Item.Attributes -band [IO.FileAttributes]::ReadOnly) {
    $Item.Attributes = $Item.Attributes -band -bnot [IO.FileAttributes]::ReadOnly
  }
  $Item.Delete()
}

# A file that can't go (one in use, say) is reported and the wipe carries on;
# the script then exits non-zero so the MDM tool shows the device as failed.
$failed = $false
function Remove-Entry([IO.FileSystemInfo]$Item) {
  try {
    Remove-Tree $Item
  } catch {
    Write-Warning "Could not remove $($Item.FullName): $($_.Exception.Message)"
    $script:failed = $true
  }
}

# Removes everything in a folder under Root except the names given, and the
# folder KeepBelow names below it (a path relative to it, empty for none) with
# the folders on its way. One reached through a junction or link is skipped
# and reported.
function Remove-AllExcept([string]$Dir, [string]$Root, [string[]]$Keep, [string]$KeepBelow = "") {
  if (-not (Test-RealFolder $Dir $Root)) {
    if (Test-Path -LiteralPath $Dir) {
      Write-Warning "Skipped $($Dir): it is reached through a junction or link"
      $script:failed = $true
    }
    return
  }
  foreach ($item in Get-ChildItem -LiteralPath $Dir -Force) {
    if ($Keep -contains $item.Name) { continue }
    if ($KeepBelow -and ($KeepBelow -eq $item.Name -or $KeepBelow.StartsWith("$($item.Name)\", [StringComparison]::OrdinalIgnoreCase))) {
      if ($KeepBelow -ne $item.Name) {
        Remove-AllExcept $item.FullName $Root @() $KeepBelow.Substring($item.Name.Length + 1)
      }
      continue
    }
    Remove-Entry $item
  }
}

function Remove-TempFiles([string]$Dir, [string]$Root) {
  if (-not (Test-RealFolder $Dir $Root)) { return }
  Get-ChildItem -LiteralPath $Dir -Force |
    Where-Object { $name = $_.Name; $tempPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) } } |
    ForEach-Object { Remove-Entry $_ }
}

# AuditLogPath from the device policy, in the 64-bit registry view the app
# reads, whichever PowerShell runs this.
$policyKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey("LocalMachine", "Registry64").OpenSubKey("SOFTWARE\Policies\OpenWhispr")
$auditLogPath = if ($policyKey) { $policyKey.GetValue("AuditLogPath") }
if (-not ($auditLogPath -is [string] -and [IO.Path]::IsPathRooted($auditLogPath))) { $auditLogPath = $null }

# Assigning to $UserProfile would run its ValidateScript again, and a profile
# whose folder is gone would then stop the run.
$profilePaths = if ($UserProfile) { $UserProfile } else {
  Get-CimInstance Win32_UserProfile |
    Where-Object { -not $_.Special -and $_.LocalPath } |
    ForEach-Object { $_.LocalPath }
}

$kept = $keptUserData
$cacheKept = @()
if (-not $IncludeModels) {
  $kept += $modelUserData
  $cacheKept = $modelCache
}

# SYSTEM can't act as the user, so a profile whose user is signed in waits: they
# could swap a folder for a junction mid-run and send the deletes elsewhere. With
# a WipeLocalDataOnLaunch token deployed, the app wipes itself at its next
# launch; run this again once they've signed out.
$signedIn = @(Get-CimInstance Win32_Process | ForEach-Object {
    (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
  })
$fullPath = { param($Path) [IO.Path]::GetFullPath($Path).TrimEnd("\") }
$profileSids = @{}
# Users' profiles only: SYSTEM and the service accounts run this script.
Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } |
  ForEach-Object { $profileSids[(& $fullPath $_.LocalPath)] = $_.SID }
$someoneSignedIn = @($signedIn | Where-Object { $profileSids.Values -contains $_ }).Count -gt 0

# Records a profile's wipe in its user's audit log as the app records its own
# (meetingAuditLog.js): one line in their daily file, in AuditLogPath or else
# the audit folder the wipe keeps. A daily file that is a link is refused, and
# AuditLogPath, which other users may write in, is used only while no one is
# signed in, as with the shared folders below, and only when it already exists
# with no junction or link on its way.
function Write-WipeRecord([string]$Sid, [string]$UserData, [string]$ProfilePath, [bool]$Incomplete) {
  $user = try {
    ([Security.Principal.SecurityIdentifier]$Sid).Translate([Security.Principal.NTAccount]).Value.Split("\")[-1]
  } catch { "unknown" }
  $user = $user -replace '[\\/:*?"<>|\x00-\x1f]', "_"
  $ts = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
  $line = [ordered]@{
    ts = $ts; event = "local-data.wiped"; sessionId = $null; noteId = $null; trigger = "script"
    reason = $(if ($Incomplete) { "incomplete" } else { $null }); durationSec = $null
    participantsNotified = $null; notificationMethod = $null; externalAttendees = $null
    appVersion = $null; deviceUser = $user
  } | ConvertTo-Json -Compress
  $default = Join-Path $UserData "audit"
  $dirs = @(if ($auditLogPath -and -not $someoneSignedIn) { $auditLogPath }) + $default
  foreach ($dir in $dirs) {
    try {
      if ($dir -ne $default -and -not (Test-RealFolder $dir ([IO.Path]::GetPathRoot($dir)))) { continue }
      if ($dir -eq $default -and -not (Test-RealFolder $UserData $ProfilePath)) { continue }
      $null = [IO.Directory]::CreateDirectory($dir)
      if ($dir -eq $default -and -not (Test-RealFolder $dir $ProfilePath)) { continue }
      $file = Join-Path $dir "meeting-audit-$user-$($ts.Substring(0, 10)).jsonl"
      $existing = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      if ($existing -and ($existing -isnot [IO.FileInfo] -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint))) { continue }
      [IO.File]::AppendAllText($file, "$line`n")
      return
    } catch {}
  }
  Write-Warning "Could not record the wipe in the audit log for $ProfilePath"
  $script:failed = $true
}

foreach ($profilePath in $profilePaths) {
  $sid = $profileSids[(& $fullPath $profilePath)]
  if ($sid -and $signedIn -contains $sid) {
    Write-Warning "Skipped $($profilePath): its user is signed in. Run again after they sign out."
    $script:failed = $true
    continue
  }
  # Counted per profile, so "Removed" names only profiles where nothing failed.
  $failedBefore = $failed
  $failed = $false
  $userData = Join-Path $profilePath "AppData\Roaming\OpenWhispr"
  # An AuditLogPath inside the data folder stays, with the folders on its way.
  $dataPrefix = (& $fullPath $userData) + "\"
  $auditKeep = if ($auditLogPath -and (& $fullPath $auditLogPath).StartsWith($dataPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    (& $fullPath $auditLogPath).Substring($dataPrefix.Length)
  } else { "" }
  # A notes folder the user chose is left to the app's own wipe (the
  # WipeLocalDataOnLaunch key): only its database says which files there are
  # the mirror's, and Windows has no SQLite to read it with.
  Remove-AllExcept $userData $profilePath $kept $auditKeep
  Remove-AllExcept (Join-Path $profilePath ".cache\openwhispr") $profilePath $cacheKept
  $bridge = Join-Path $profilePath ".openwhispr"
  $bridgeFile = Join-Path $bridge "cli-bridge.json"
  if ((Test-RealFolder $bridge $profilePath) -and (Test-Path -LiteralPath $bridgeFile -PathType Leaf)) {
    Remove-Entry (Get-Item -LiteralPath $bridgeFile -Force)
  }
  Remove-TempFiles (Join-Path $profilePath "AppData\Local\Temp") $profilePath
  $hadData = Test-Path -LiteralPath $userData
  if ($hadData) { Write-WipeRecord $sid $userData $profilePath $failed }
  if (-not $failed -and $hadData) { Write-Output "Removed OpenWhispr local data from $profilePath" }
  $failed = $failed -or $failedBefore
}

# The ASCII-only fallbacks the app uses when a profile path has spaces or
# non-ASCII characters; they are shared by every user of the device, so any
# signed-in user could swap a folder there for a junction.
$sharedRoots = @($env:ProgramData, "$env:SystemDrive\")
$sharedExists = @($sharedRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ "OpenWhispr") }).Count -gt 0
if ($sharedExists -and $someoneSignedIn) {
  Write-Warning "Skipped the shared folders in $env:ProgramData\OpenWhispr and $env:SystemDrive\OpenWhispr while a user is signed in. Run again when no one is."
  $script:failed = $true
} else {
  foreach ($root in $sharedRoots) {
    $app = Join-Path $root "OpenWhispr"
    Remove-TempFiles (Join-Path $app "temp") $root
    Remove-AllExcept (Join-Path $app "cache") $root $cacheKept
  }
}

if ($failed) { exit 1 }
