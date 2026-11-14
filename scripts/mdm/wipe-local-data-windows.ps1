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

# Every file under a folder, never through a junction or link. A folder that
# can't be read holds nothing the mirror could have written.
function Get-FilesBelow([IO.DirectoryInfo]$Folder) {
  try { $items = $Folder.GetFileSystemInfos() } catch { return }
  foreach ($item in $items) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    if ($item -is [IO.DirectoryInfo]) { Get-FilesBelow $item } else { $item }
  }
}

# In a folder of the profile the user chose for the notes mirror, removes only
# the files the mirror wrote, at any depth of its workspace, space and folder
# layout: "<id>-<slug>.md" opening with "---" and "id: <id>" (also when kept
# aside as "edited-<name>"), their "<id>-...-transcript" companions, and
# folders that leaves empty. The chosen folder itself stays. A file that can't
# be read is skipped.
function Remove-MirroredFiles([string]$Base, [string]$Root) {
  if (-not (Test-RealFolder $Base $Root)) { return }
  $files = @(Get-FilesBelow (Get-Item -LiteralPath $Base -Force))
  $ids = @{}
  $emptied = @{}
  foreach ($file in $files) {
    if ($file.Extension -ne ".md") { continue }
    try {
      $head = (Get-Content -LiteralPath $file.FullName -TotalCount 2 -Encoding UTF8) -join "`n"
    } catch { continue }
    if (-not ($head.TrimStart([char]0xFEFF) -match '^---\nid: (\d+)$')) { continue }
    $id = $Matches[1]
    if (-not ($file.Name -match "^(edited-(\d+-)?)?$id-.*\.md$")) { continue }
    Remove-Entry $file
    $ids[$id] = $true
    $emptied[$file.DirectoryName] = $true
  }
  foreach ($file in $files) {
    if ($file.Name -match '^(edited-(\d+-)?)?(\d+)-.*-transcript\.(md|txt)$' -and $ids.ContainsKey($Matches[3])) {
      Remove-Entry $file
      $emptied[$file.DirectoryName] = $true
    }
  }
  # Up to the chosen folder, each folder left with nothing but what Explorer or
  # Finder leave behind.
  $top = [IO.Path]::GetFullPath($Base).TrimEnd("\")
  foreach ($folder in @($emptied.Keys)) {
    try {
      $dir = Get-Item -LiteralPath $folder -Force
      while ($dir.FullName.TrimEnd("\").Length -gt $top.Length) {
        $left = @($dir.GetFileSystemInfos() | Where-Object { @(".DS_Store", "Thumbs.db", "desktop.ini") -notcontains $_.Name })
        if ($left.Count) { break }
        Remove-Entry $dir
        $dir = $dir.Parent
      }
    } catch { }
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
        try {
          Remove-MirroredFiles $basePath $profilePath
        } catch {
          Write-Warning "Could not clear the notes folder $($basePath): $($_.Exception.Message)"
          $script:failed = $true
        }
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
