# Removes OpenWhispr's local data from a Windows device being offboarded
# (#3030), for MDM tools that run scripts as SYSTEM (Intune). OpenWhispr is
# closed first. The WipeLocalDataOnLaunch device key does the same from inside
# the app.
#
#   wipe-local-data-windows.ps1 [-IncludeModels] [-UserProfile C:\Users\name, ...]
#
# Covers every user profile unless profiles are named. Downloaded models stay
# unless -IncludeModels is passed. The audit log stays, as does the record of
# the last WipeLocalDataOnLaunch token, so the app doesn't wipe a second time.
# See docs/mdm-local-data-wipe.md.

param(
  [switch]$IncludeModels,
  [string[]]$UserProfile
)

$ErrorActionPreference = "Stop"

# The same lists as KEPT_USER_DATA_ENTRIES, MODEL_USER_DATA_ENTRIES,
# MODEL_CACHE_ENTRIES and TEMP_PREFIXES in src/helpers/localDataWipe.js.
$keptUserData = @("audit", "meeting-audit-session.json", "meeting-audit-session.json.tmp", "local-data-wipe.json")
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

# Removes everything in a folder under Root except the names given.
function Remove-AllExcept([string]$Dir, [string]$Root, [string[]]$Keep) {
  if (-not (Test-RealFolder $Dir $Root)) { return }
  Get-ChildItem -LiteralPath $Dir -Force |
    Where-Object { $Keep -notcontains $_.Name } |
    ForEach-Object { Remove-Entry $_ }
}

function Remove-TempFiles([string]$Dir, [string]$Root) {
  if (-not (Test-RealFolder $Dir $Root)) { return }
  Get-ChildItem -LiteralPath $Dir -Force |
    Where-Object { $name = $_.Name; $tempPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) } } |
    ForEach-Object { Remove-Entry $_ }
}

# In a folder of the profile the user chose for the notes mirror, removes only
# the files the mirror wrote: "<id>-<slug>.md" opening with "---" and "id: <id>",
# their "<id>-...-transcript" companions, and folders that leaves empty. The
# chosen folder itself stays.
function Remove-MirroredFiles([string]$Base, [string]$Root) {
  if (-not (Test-RealFolder $Base $Root)) { return }
  $folders = Get-ChildItem -LiteralPath $Base -Directory -Force |
    Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }
  $ids = @{}
  $emptied = @{}
  foreach ($folder in $folders) {
    foreach ($file in Get-ChildItem -LiteralPath $folder.FullName -File -Filter "*.md" -Force) {
      if ($file.Name -notmatch '^(\d+)-.*\.md$') { continue }
      $id = $Matches[1]
      $head = (Get-Content -LiteralPath $file.FullName -TotalCount 2 -Encoding UTF8) -join "`n"
      if ($head.TrimStart([char]0xFEFF) -eq "---`nid: $id") {
        Remove-Entry $file
        $ids[$id] = $true
        $emptied[$folder.FullName] = $true
      }
    }
  }
  foreach ($folder in $folders) {
    foreach ($file in Get-ChildItem -LiteralPath $folder.FullName -File -Force) {
      if ($file.Name -match '^(\d+)-.*-transcript\.(md|txt)$' -and $ids.ContainsKey($Matches[1])) {
        Remove-Entry $file
        $emptied[$folder.FullName] = $true
      }
    }
  }
  foreach ($folder in $emptied.Keys) {
    if (-not (Get-ChildItem -LiteralPath $folder -Force)) { Remove-Entry (Get-Item -LiteralPath $folder -Force) }
  }
}

# The app and its sidecars (search index, local models), which run from the
# install's resources folder and may hold files open.
$running = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -eq "OpenWhispr" -or $_.Path -like "*\OpenWhispr\resources\*" }
if ($running) {
  $running | Stop-Process -Force
  $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
}

if (-not $UserProfile) {
  $UserProfile = Get-CimInstance Win32_UserProfile |
    Where-Object { -not $_.Special -and $_.LocalPath } |
    ForEach-Object { $_.LocalPath }
}

$kept = $keptUserData
$cacheKept = @()
if (-not $IncludeModels) {
  $kept += $modelUserData
  $cacheKept = $modelCache
}

foreach ($profilePath in $UserProfile) {
  $userData = Join-Path $profilePath "AppData\Roaming\OpenWhispr"
  # Every folder the mirror wrote to, from the app's record of them.
  $mirrorRecord = Join-Path $userData "notes-mirror.json"
  if ((Test-RealFolder $userData $profilePath) -and (Test-Path -LiteralPath $mirrorRecord -PathType Leaf)) {
    try {
      $basePaths = (Get-Content -LiteralPath $mirrorRecord -Raw -Encoding UTF8 | ConvertFrom-Json).basePaths
    } catch {
      $basePaths = @() # An unreadable record names no folder.
    }
    foreach ($basePath in $basePaths) {
      if ($basePath -is [string] -and [IO.Path]::IsPathRooted($basePath)) {
        Remove-MirroredFiles $basePath $profilePath
      }
    }
  }
  Remove-AllExcept $userData $profilePath $kept
  Remove-AllExcept (Join-Path $profilePath ".cache\openwhispr") $profilePath $cacheKept
  $bridge = Join-Path $profilePath ".openwhispr"
  $bridgeFile = Join-Path $bridge "cli-bridge.json"
  if ((Test-RealFolder $bridge $profilePath) -and (Test-Path -LiteralPath $bridgeFile -PathType Leaf)) {
    Remove-Entry (Get-Item -LiteralPath $bridgeFile -Force)
  }
  Remove-TempFiles (Join-Path $profilePath "AppData\Local\Temp") $profilePath
  Write-Output "Removed OpenWhispr local data from $profilePath"
}

# The ASCII-only fallbacks the app uses when a profile path has spaces or
# non-ASCII characters; they are shared by every user of the device.
foreach ($root in @($env:ProgramData, "$env:SystemDrive\")) {
  $app = Join-Path $root "OpenWhispr"
  Remove-TempFiles (Join-Path $app "temp") $root
  Remove-AllExcept (Join-Path $app "cache") $root $cacheKept
}

if ($failed) { exit 1 }
