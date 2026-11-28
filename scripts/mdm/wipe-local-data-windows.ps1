# Removes OpenWhispr's local data from a Windows device being offboarded
# (#3323), for MDM tools that run scripts as SYSTEM (Intune). A profile whose
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

# PowerShell 7 lacks the .NET calls the notes cleanup uses.
#Requires -PSEdition Desktop

# A parameter it doesn't know stops the run rather than leaving -UserProfile
# empty, which would wipe every profile.
[CmdletBinding()]
param(
  [switch]$IncludeModels,
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
  [string[]]$UserProfile
)

$ErrorActionPreference = "Stop"

# AppLocker or WDAC can run scripts in constrained language, which allows none
# of the .NET calls this one makes, so it stops before removing anything.
$mode = $ExecutionContext.SessionState.LanguageMode
if ($mode -ne "FullLanguage") {
  Write-Warning "Nothing was removed: PowerShell runs this script in $mode mode. Sign it or allow it in your AppLocker or WDAC policy so it runs in full language mode."
  exit 1
}

# The same lists as KEPT_USER_DATA_ENTRIES, MODEL_USER_DATA_ENTRIES,
# MODEL_CACHE_ENTRIES and TEMP_PREFIXES in src/helpers/localDataWipe.js.
$keptUserData = @("audit", "meeting-audit-session.json", "meeting-audit-session.json.tmp", "local-data-wipe.json", "local-data-wipe.json.tmp", "local-data-wipe.pending", "globe-preference-state.json")
$modelUserData = @("installed-models.json")
$modelCache = @("whisper-models", "parakeet-models", "diarization-models", "models", "whisper-vad", "embedding-models")
$tempPrefixes = @("ow-", "openwhispr-", "whisper-input-", "whisper-output-", "parakeet-", "enterprise-buffer-", "enterprise-chunks-", "kwin-active-class-")

# A name ending in a character Windows can drop from a name (a dot or space)
# or Windows PowerShell's .NET from the end of a path (a no-break space, U+0085
# too). The script could look at such a name as one entry and go through it as
# another, say a junction beside it, so it never does either.
$trimmable = '[. \u0085\u00A0]$'

# Whether Path is inside Root with no junction or symbolic link on the way:
# running as SYSTEM, a link a user made must never lead the script elsewhere.
# So each folder is looked at from Root down, one name at a time, before
# anything goes through it (resolving Path whole would first read every folder
# of a path with a "~" in it), and Root, which every caller gives in full, isn't
# resolved. A $trimmable name is refused, as are "." and "..". $null when no
# folder is at Path and no link is on the way to it.
function Test-RealFolder([string]$Path, [string]$Root) {
  $at = $Root.Replace("/", "\").TrimEnd("\")
  $target = $Path.Replace("/", "\").TrimEnd("\")
  if (-not $target.StartsWith("$at\", [StringComparison]::OrdinalIgnoreCase)) { return $false }
  try {
    foreach ($name in $target.Substring($at.Length + 1).Split("\")) {
      if ($name -eq "" -or $name -match $trimmable) { return $false }
      $at = "$at\$name"
      $folder = New-Object IO.DirectoryInfo $at
      # Read before Exists, which is false for a link to a file, one Windows
      # still goes through; -1, every bit set, is nothing there.
      $attributes = [int]$folder.Attributes
      if ($attributes -ne -1 -and ($attributes -band [int][IO.FileAttributes]::ReparsePoint)) { return $false }
      if (-not $folder.Exists) { return $null }
    }
  } catch {
    return $false
  }
  return $true
}

$fullPath = { param($Path) [IO.Path]::GetFullPath($Path).TrimEnd("\") }

# Deletes a file or folder tree, read-only files included. A junction or link
# is removed itself, never what it points to (Windows PowerShell's
# Remove-Item -Recurse can follow one), and each delete goes only where its path
# really leads (OpenWhisprNative.Delete), so a user who signs in mid-run can't
# swap a junction in on the way and send it elsewhere.
function Remove-Tree([IO.FileSystemInfo]$Item) {
  $isLink = $Item.Attributes -band [IO.FileAttributes]::ReparsePoint
  if ($Item -is [IO.DirectoryInfo] -and -not $isLink) {
    foreach ($child in $Item.GetFileSystemInfos()) { Remove-Entry $child }
  }
  [OpenWhisprNative]::Delete($Item.FullName)
}

# A file that can't go (one in use, say) is reported and the wipe carries on;
# the script then exits non-zero so the MDM tool shows the device as failed.
$failed = $false
# A store (-Store) the user moved elsewhere and left a junction or link in place
# of: the link goes, but what it leads to isn't followed, so it is reported, as
# the app reports it.
function Remove-Entry([IO.FileSystemInfo]$Item, [switch]$Store) {
  try {
    if ($Item.Name -match $trimmable) { throw "its name ends in a dot or space" }
    # Read while the link is there.
    $target = if ($Store -and ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { "$($Item.Target -join ", ")" }
    Remove-Tree $Item
    if ($null -ne $target) {
      Write-Warning "Removed $($Item.FullName): it led to $(if ($target) { $target } else { "elsewhere" }), which wasn't removed"
      $script:failed = $true
    }
  } catch {
    Write-Warning "Could not remove $($Item.FullName): $($_.Exception.Message)"
    $script:failed = $true
  }
}

# Test-RealFolder for a folder the script cleans: one reached through a
# junction or link is reported, so the run fails rather than leaving it.
function Test-ReachedFolder([string]$Dir, [string]$Root) {
  $real = Test-RealFolder $Dir $Root
  if ($real -eq $false) {
    Write-Warning "Skipped $($Dir): it is reached through a junction or link"
    $script:failed = $true
  }
  return $real
}

# The daily files meetingAuditLog.js writes, every user's.
$auditFile = '^meeting-audit-.+-\d{4}-\d{2}-\d{2}\.jsonl$'

# Removes everything in a folder under Root except the names given. An
# AuditLogPath (Audit) inside it keeps its audit files and the folders on the
# way to it; everything else in that folder goes. One reached through a
# junction or link is skipped and reported.
function Remove-AllExcept([string]$Dir, [string]$Root, [string[]]$Keep, [string]$Audit) {
  if (-not (Test-ReachedFolder $Dir $Root)) { return }
  $audit = if ($Audit) { & $fullPath $Audit }
  $isAuditDir = $audit -and (& $fullPath $Dir) -eq $audit
  foreach ($item in Get-ChildItem -LiteralPath $Dir -Force) {
    if ($Keep -contains $item.Name) { continue }
    if ($isAuditDir -and $item -is [IO.FileInfo] -and $item.Name -match $auditFile) { continue }
    $onTheWay = $audit -and $item -is [IO.DirectoryInfo] -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
      ($audit -eq $item.FullName -or $audit.StartsWith("$($item.FullName)\", [StringComparison]::OrdinalIgnoreCase))
    if ($onTheWay) { Remove-AllExcept $item.FullName $Root @() $Audit } else { Remove-Entry $item -Store }
  }
}

function Remove-TempFiles([string]$Dir, [string]$Root) {
  if (-not (Test-ReachedFolder $Dir $Root)) { return }
  Get-ChildItem -LiteralPath $Dir -Force |
    Where-Object { $name = $_.Name; $tempPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) } } |
    ForEach-Object { Remove-Entry $_ -Store }
}

# The native calls the script makes, compiled once: queries through the SQLite
# that ships with Windows 10 and 11 (winsqlite3.dll; Windows has no sqlite3
# tool), an open file's hard link count and real path, and deletes through it.
function Initialize-Native {
  if ("OpenWhisprNative" -as [type]) { return }
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class OpenWhisprNative {
  [DllImport("winsqlite3.dll")] static extern int sqlite3_open_v2(byte[] name, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CharSet = CharSet.Unicode)] static extern int sqlite3_prepare16_v2(IntPtr db, string sql, int bytes, out IntPtr stmt, IntPtr tail);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_step(IntPtr stmt);
  [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_column_text16(IntPtr stmt, int column);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_finalize(IntPtr stmt);
  [DllImport("winsqlite3.dll")] static extern int sqlite3_close_v2(IntPtr db);
  [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_errmsg16(IntPtr db);

  public static List<string[]> Query(string path, string sql, int columns) {
    IntPtr db, stmt;
    // Read-write, so a journal or write-ahead log beside it is applied.
    int rc = sqlite3_open_v2(Encoding.UTF8.GetBytes(path + "\0"), out db, 2, IntPtr.Zero);
    try {
      if (rc != 0 || sqlite3_prepare16_v2(db, sql, -1, out stmt, IntPtr.Zero) != 0) throw Failure(db);
      try {
        var rows = new List<string[]>();
        while ((rc = sqlite3_step(stmt)) == 100) {
          var row = new string[columns];
          for (int i = 0; i < columns; i++) row[i] = Marshal.PtrToStringUni(sqlite3_column_text16(stmt, i));
          rows.Add(row);
        }
        if (rc != 101) throw Failure(db);
        return rows;
      } finally {
        sqlite3_finalize(stmt);
      }
    } finally {
      sqlite3_close_v2(db);
    }
  }

  static Exception Failure(IntPtr db) {
    return new Exception(Marshal.PtrToStringUni(sqlite3_errmsg16(db)));
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle file, uint[] info);

  // nNumberOfLinks, the 11th of the 13 DWORDs in BY_HANDLE_FILE_INFORMATION.
  public static uint LinkCount(SafeFileHandle file) {
    var info = new uint[13];
    if (!GetFileInformationByHandle(file, info)) throw new Win32Exception();
    return info[10];
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass, ref uint info, uint size);

  static string Extended(string path) {
    return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
  }

  static string FinalPath(SafeFileHandle file) {
    var real = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(file, real, (uint)real.Capacity, 0);
    if (length == 0 || length >= real.Capacity) throw new Win32Exception();
    return real.ToString();
  }

  // Whether an open file is the one at path, reached with no junction or link
  // on the way.
  public static bool IsAt(SafeFileHandle file, string path) {
    return string.Equals(FinalPath(file), Extended(path), StringComparison.OrdinalIgnoreCase);
  }

  // A folder's path as IsAt compares it: short names in long form, and any
  // junction on the way to it resolved. Only for a root users can't swap.
  public static string RealPath(string path) {
    // FILE_READ_ATTRIBUTES, shared, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS.
    using (var file = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new Win32Exception();
      string real = FinalPath(file);
      return real.StartsWith(@"\\?\UNC\") ? @"\\" + real.Substring(8) : real.Substring(4);
    }
  }

  // Deletes the file, empty folder or link at path, read-only or not, through a
  // handle opened without following a link, once the handle shows it is there.
  public static void Delete(string path) {
    // DELETE and FILE_READ_ATTRIBUTES, shared, OPEN_EXISTING, with
    // FILE_FLAG_BACKUP_SEMANTICS (folders) and FILE_FLAG_OPEN_REPARSE_POINT.
    using (var file = CreateFileW(Extended(path), 0x10080, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new Win32Exception();
      if (!IsAt(file, path)) throw new Exception("it is reached through a junction or link");
      // FileDispositionInfoEx: FILE_DISPOSITION_FLAG_DELETE and _IGNORE_READONLY_ATTRIBUTE.
      uint flags = 0x11;
      if (!SetFileInformationByHandle(file, 21, ref flags, 4)) throw new Win32Exception();
    }
  }
}
"@
}

# Each row of a query on a SQLite database, as text.
function Read-Sqlite([string]$Database, [string]$Query, [int]$Columns) {
  return , [OpenWhisprNative]::Query($Database, $Query, $Columns)
}

Initialize-Native

# Where the database copies go, as IsAt compares it (an admin's temp folder can
# be named with a short 8.3 name).
$tempRoot = [OpenWhisprNative]::RealPath([IO.Path]::GetTempPath())

# A folder holding nothing but the files Finder or Windows Explorer leave behind.
function Remove-IfEmptied([string]$Dir) {
  $children = @(Get-ChildItem -LiteralPath $Dir -Force)
  if (@($children | Where-Object { -not ($_ -is [IO.FileInfo] -and @(".DS_Store", "Thumbs.db", "desktop.ini") -contains $_.Name) }).Count) { return $false }
  foreach ($child in $children) { Remove-Tree $child }
  [OpenWhisprNative]::Delete((Get-Item -LiteralPath $Dir -Force).FullName)
  return $true
}

# In each folder of the profile the notes mirror wrote to, the user's chosen
# ones included, removes only the files the app's database records it writing
# there that still hold what it wrote (a BOM and CRLF line endings aside, as
# the app reads them), and folders that leaves empty. Anything else, an outside
# edit included, is the user's. The chosen folder itself stays, and nothing is
# reached through a junction or link. The database is read from a copy only
# SYSTEM and Administrators can open, so a row still in its write-ahead log
# counts and a journal left beside it is replayed into the copy, never into a
# file it is a hard link to. Returns whether a recorded file was left behind or
# the record couldn't be read, so the database that lists them stays for a run
# again.
function Remove-MirroredFiles([string]$UserData, [string]$ProfilePath, [string]$ListedPath) {
  $database = Join-Path $UserData "transcriptions.db"
  if (-not (Test-RealFolder $UserData $ProfilePath)) { return $false }
  $source = Get-Item -LiteralPath $database -Force -ErrorAction SilentlyContinue
  if (-not ($source -is [IO.FileInfo]) -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in "S-1-5-18", "S-1-5-32-544") {
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
          (New-Object Security.Principal.SecurityIdentifier $sid), "FullControl", "ContainerInherit, ObjectInherit", "None", "Allow")))
  }
  try {
    $copy = [IO.Directory]::CreateDirectory((Join-Path $tempRoot "wipe-local-data-$([guid]::NewGuid())"), $security)
    try {
      foreach ($suffix in "", "-wal", "-journal") {
        $file = Get-Item -LiteralPath "$database$suffix" -Force -ErrorAction SilentlyContinue
        if ($file -is [IO.FileInfo] -and -not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
          # A sparse file takes no room where it is but all of it copied, so
          # only one as the app writes it is copied, and no more than the macOS
          # script reads.
          if (($file.Attributes -band [IO.FileAttributes]::SparseFile) -or $file.Length -gt 4GB) {
            throw "$($file.Name) is sparse or larger than 4 GB"
          }
          [IO.File]::Copy($file.FullName, (Join-Path $copy.FullName "transcriptions.db$suffix"))
        }
      }
      $copied = Join-Path $copy.FullName "transcriptions.db"
      # A version from before the mirror kept its record names no file, and only
      # a plain table its own SQL names is the app's, never a virtual one whose
      # module would run as SYSTEM on a file the user made.
      $rows = if ((Read-Sqlite $copied "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_mirror_files' AND sql GLOB 'CREATE TABLE note_mirror_files[ (]*'" 1).Count) {
        Read-Sqlite $copied "SELECT base_path, rel_path, kind, content_hash FROM note_mirror_files ORDER BY base_path, rel_path" 4
      }
    } finally {
      # A copy left behind holds the user's notes: reported, and swept next run.
      Remove-Entry $copy
    }
  } catch {
    Write-Warning "Could not read the notes mirror's record in $($database): $($_.Exception.Message)"
    $script:failed = $true
    return $true
  }

  $profileRoot = & $fullPath $ProfilePath
  $listedRoot = & $fullPath $ListedPath
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $hashOf = { param($Text) -join ($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString("x2") }) }
  $leftBehind = $false
  $vacated = @{}
  $skipped = $null
  $outside = $null
  $linked = @{}
  $unsafe = $false
  foreach ($row in $rows) {
    $base, $rel, $kind, $hash = $row
    $base = $base.Replace("/", "\").TrimEnd("\")
    # The app records a folder by the profile path Windows lists, through a
    # volume mounted in a folder too: the same folder as the real one.
    if ($listedRoot -ne $profileRoot -and ([string]::Equals($base, $listedRoot, [StringComparison]::OrdinalIgnoreCase) -or $base.StartsWith("$listedRoot\", [StringComparison]::OrdinalIgnoreCase))) {
      $base = $profileRoot + $base.Substring($listedRoot.Length)
    }
    # As SYSTEM the script never leaves the profile, not even to look (a share
    # would get the device's credentials), so this is decided from the path as
    # recorded (a real path, so with no "." or ".." in it), before anything
    # reads or resolves it. A notes folder outside the profile is reported for
    # you to clean, and the database still goes, since keeping it would keep
    # every note.
    $names = $base.Split("\")
    # Compared as the file system does: PowerShell's -eq ignores characters
    # such as a soft hyphen, which a planted folder's name could carry.
    $isProfile = [string]::Equals($base, $profileRoot, [StringComparison]::OrdinalIgnoreCase)
    if ((-not $isProfile -and -not $base.StartsWith("$profileRoot\", [StringComparison]::OrdinalIgnoreCase)) -or
      $names -contains "." -or $names -contains "..") {
      if ($base -ne $outside) { Write-Warning "Skipped $($base): it is outside $ProfilePath" }
      $outside = $base
      continue
    }
    $file = "$base\$($rel.Replace("/", "\"))"
    # One under a $trimmable name, the notes folder's own included, can't be
    # reached safely: reported and left, like a notes folder outside the profile.
    if (@($file.Substring($profileRoot.Length + 1).Split("\") | Where-Object { $_ -notmatch '^\.\.?$' -and $_ -match $trimmable }).Count) {
      Write-Warning "Skipped $($file): a name on its way ends in a dot or space"
      $unsafe = $true
      continue
    }
    # Nor can one whose path is too long for Windows PowerShell, which finds
    # nothing there.
    if ($file.Length -ge 260) {
      Write-Warning "Skipped $($file): its path is too long for Windows PowerShell"
      $unsafe = $true
      continue
    }
    $real = if ($isProfile) { $true } else { Test-RealFolder $base $ProfilePath }
    # Gone: the user deleted it.
    if ($null -eq $real) { continue }
    # A junction or link put on its way isn't the folder the mirror wrote to.
    if (-not $real) {
      if ($base -ne $skipped) { Write-Warning "Skipped $($base): it now leads elsewhere" }
      $skipped = $base
      $leftBehind = $true
      continue
    }
    # A folder directory it made, gone with the folders below once empty; never
    # the notes folder itself.
    if ($kind -eq "dir") {
      $file = $file.TrimEnd("\")
      if (Test-RealFolder $file $base) { $vacated[$file] = $base }
      continue
    }
    $dir = Split-Path $file
    if ($dir -ne $base) {
      # Never the mirror's: one that leads out through "..".
      if (@($rel -split '[\\/]' | Where-Object { $_ -match '^\.\.?$' }).Count) { continue }
      $reached = Test-RealFolder $dir $base
      if ($null -eq $reached) { continue }
      # A folder on its way that is now a junction or link, which the mirror
      # never writes through: what it leads to stays for you to clean, and the
      # database still goes, as with a notes folder outside the profile.
      if (-not $reached) {
        if (-not $linked.ContainsKey($dir)) {
          Write-Warning "Skipped $($dir): it is reached through a junction or link, so its notes weren't removed"
          $linked[$dir] = $true
        }
        $unsafe = $true
        continue
      }
    }
    $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if (-not ($item -is [IO.FileInfo])) { continue }
    # A link put in its place, or a sync client's placeholder (OneDrive Files
    # On-Demand), may still hold what it wrote: a failure, not an edit.
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Write-Warning "Skipped $($file): it is a link or a cloud file"
      $leftBehind = $true
      continue
    }
    # One it can't read may still hold what it wrote: a failure, not an edit.
    try {
      $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($file))
    } catch {
      Write-Warning "Could not read $($file): $($_.Exception.Message)"
      $leftBehind = $true
      continue
    }
    if ($hash -ne (& $hashOf $text) -and $hash -ne (& $hashOf ($text -replace "^\uFEFF", "").Replace("`r`n", "`n"))) { continue }
    try {
      Remove-Tree $item
    } catch {
      Write-Warning "Could not remove $($file): $($_.Exception.Message)"
      $leftBehind = $true
      continue
    }
    $vacated[$dir] = $base
  }
  foreach ($folder in @($vacated.Keys)) {
    $base = $vacated[$folder]
    try {
      while ($folder -ne $base -and (Remove-IfEmptied $folder)) { $folder = Split-Path $folder }
    } catch {
      # Gone already, or not ours to remove.
    }
  }
  if ($leftBehind -or $outside -or $unsafe) { $script:failed = $true }
  return $leftBehind
}

# AuditLogPath from the device policy, in the 64-bit registry view the app
# reads, whichever PowerShell runs this. A REG_EXPAND_SZ value is expanded
# per profile, below.
$policyKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey("LocalMachine", "Registry64").OpenSubKey("SOFTWARE\Policies\OpenWhispr")
$auditLogPath = $null
$auditExpands = $false
if ($policyKey -and $policyKey.GetValueNames() -contains "AuditLogPath") {
  $auditLogPath = $policyKey.GetValue("AuditLogPath", $null, "DoNotExpandEnvironmentNames")
  $auditExpands = $policyKey.GetValueKind("AuditLogPath") -eq "ExpandString"
}

# AuditLogPath as the app reads it in a profile: %NAME% in a REG_EXPAND_SZ
# value comes from that user's environment, here their profile's folders and
# name, and the machine's for anything else; an unknown name stays as written.
# A path that isn't absolute is none, as in the app.
function Get-AuditLogPath([string]$ProfilePath, [string]$User) {
  $path = $auditLogPath
  if ($auditExpands) {
    $own = @{}
    if ($ProfilePath) {
      $root = & $fullPath $ProfilePath
      $local = "$root\AppData\Local"
      $own = @{
        USERPROFILE = $root; APPDATA = "$root\AppData\Roaming"; LOCALAPPDATA = $local; USERNAME = $User
        HOMEDRIVE = $root.Substring(0, 2); HOMEPATH = $root.Substring(2); TEMP = "$local\Temp"; TMP = "$local\Temp"
      }
    }
    $path = [regex]::Replace($path, '%([^%]+)%', {
        param($match)
        $name = $match.Groups[1].Value
        $value = if ($own.ContainsKey($name)) { $own[$name] } else { [Environment]::GetEnvironmentVariable($name) }
        if ($null -eq $value) { $match.Value } else { $value }
      })
  }
  # Node's path.isAbsolute: a slash first, or a drive and one (never "C:" alone).
  if ($path -is [string] -and $path -cmatch '^([\\/]|[A-Za-z]:[\\/])') { $path }
}

# The name of a profile's account, made safe for a file name, or "unknown".
function Get-ProfileUser([string]$Sid) {
  $user = try {
    ([Security.Principal.SecurityIdentifier]$Sid).Translate([Security.Principal.NTAccount]).Value.Split("\")[-1]
  } catch { "unknown" }
  $user -replace '[\\/:*?"<>|\x00-\x1f]', "_"
}

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

# A profile whose user is signed in waits: OpenWhispr may be running there,
# holding its files. With a WipeLocalDataOnLaunch token deployed, the app wipes
# itself at its next launch; run this again once they've signed out.
$signedIn = @(Get-CimInstance Win32_Process | ForEach-Object {
    (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid
  })
$profileSids = @{}
# Users' profiles only: SYSTEM and the service accounts run this script.
Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath } |
  ForEach-Object { $profileSids[(& $fullPath $_.LocalPath)] = $_.SID }
$someoneSignedIn = @($signedIn | Where-Object { $profileSids.Values -contains $_ }).Count -gt 0

# Records a profile's wipe in its user's audit log as the app records its own
# (meetingAuditLog.js): one line in their daily file, in AuditLogPath (Audit)
# or else the audit folder the wipe keeps. A daily file that is a link, or a
# hard link to another file, is refused, and AuditLogPath, which other users
# may write in, is used only while no one is signed in, as with the shared
# folders below, and only when it already exists with no junction or link on
# its way.
function Write-WipeRecord([string]$User, [string]$Audit, [string]$UserData, [string]$ProfilePath, [bool]$Incomplete) {
  $ts = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", [Globalization.CultureInfo]::InvariantCulture)
  $line = [ordered]@{
    ts = $ts; event = "local-data.wiped"; sessionId = $null; noteId = $null; trigger = "script"
    reason = $(if ($Incomplete) { "incomplete" } else { $null }); durationSec = $null
    participantsNotified = $null; notificationMethod = $null; externalAttendees = $null
    appVersion = $null; deviceUser = $User
  } | ConvertTo-Json -Compress
  $default = Join-Path $UserData "audit"
  $dirs = @(if ($Audit -and -not $someoneSignedIn) { & $fullPath $Audit }) + $default
  foreach ($dir in $dirs) {
    try {
      # A share or drive itself has no folder on its way to check.
      $root = [IO.Path]::GetPathRoot($dir).TrimEnd("\")
      if ($dir -ne $default -and $dir -ne $root -and -not (Test-RealFolder $dir $root)) { continue }
      if ($dir -eq $default -and -not (Test-RealFolder $UserData $ProfilePath)) { continue }
      $null = [IO.Directory]::CreateDirectory($dir)
      if ($dir -eq $default -and -not (Test-RealFolder $dir $ProfilePath)) { continue }
      $file = Join-Path $dir "meeting-audit-$User-$($ts.Substring(0, 10)).jsonl"
      $existing = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
      if ($existing -and ($existing -isnot [IO.FileInfo] -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint))) { continue }
      $stream = [IO.File]::Open($file, "Append", "Write", "Read")
      try {
        if ([OpenWhisprNative]::LinkCount($stream.SafeFileHandle) -ne 1) { continue }
        # Not one a junction swapped in on the way since the checks above leads to.
        if (-not [OpenWhisprNative]::IsAt($stream.SafeFileHandle, $file)) { continue }
        $bytes = [Text.Encoding]::UTF8.GetBytes("$line`n")
        $stream.Write($bytes, 0, $bytes.Length)
      } finally {
        $stream.Dispose()
      }
      return
    } catch {}
  }
  Write-Warning "Could not record the wipe in the audit log for $ProfilePath"
  $script:failed = $true
}

# The ASCII-only fallbacks the app uses when a profile path has spaces or
# non-ASCII characters; they are shared by every user of the device, so any
# signed-in user could swap a folder there for a junction. Cleaned first, so
# the wipe of a profile whose data may be in them finishes only once they are.
$sharedRoots = @($env:ProgramData, "$env:SystemDrive\")
$sharedExists = @($sharedRoots | Where-Object { Test-Path -LiteralPath (Join-Path $_ "OpenWhispr") }).Count -gt 0
if ($sharedExists -and $someoneSignedIn) {
  Write-Warning "Skipped the shared folders in $env:ProgramData\OpenWhispr and $env:SystemDrive\OpenWhispr while a user is signed in. Run again when no one is."
  $failed = $true
} else {
  foreach ($root in $sharedRoots) {
    $app = Join-Path $root "OpenWhispr"
    try {
      Remove-TempFiles (Join-Path $app "temp") $root
      Remove-AllExcept (Join-Path $app "cache") $root $cacheKept (Get-AuditLogPath)
    } catch {
      Write-Warning "Could not clean $($app): $($_.Exception.Message)"
      $failed = $true
    }
  }
}
$sharedFailed = $failed

# Database copies a run cut short while reading one left (Remove-MirroredFiles),
# made by SYSTEM, never a folder a user put at such a name (SYSTEM's temp
# folder on Windows 10, C:\Windows\Temp, lets users create one). After the
# shared folders, so one it can't remove fails the run but not their wipe.
$privileged = @("S-1-5-18", "S-1-5-32-544")
foreach ($leftover in Get-ChildItem -LiteralPath $tempRoot -Filter "wipe-local-data-*" -Directory -Force -ErrorAction SilentlyContinue) {
  # One whose owner SYSTEM may not read isn't SYSTEM's.
  $owner = try { $leftover.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $null }
  if (-not ($leftover.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $privileged -contains $owner) {
    Remove-Entry $leftover
  }
}

foreach ($profilePath in $profilePaths) {
  # As Test-RealFolder compares it with paths built on it.
  $profilePath = & $fullPath $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($profilePath)
  $sid = $profileSids[$profilePath]
  if ($sid -and $signedIn -contains $sid) {
    Write-Warning "Skipped $($profilePath): its user is signed in. Run again after they sign out."
    $script:failed = $true
    continue
  }
  # A profile named by another path to it (C:\Documents and Settings\name)
  # can't be told apart from one whose user is signed in.
  if (-not $sid -and $someoneSignedIn) {
    Write-Warning "Skipped $($profilePath): it isn't the path Windows lists for a user profile, and a user is signed in. Name the profile by that path, or run again when no one is signed in."
    $script:failed = $true
    continue
  }
  # As IsAt compares the paths built on it (a short name, or C:\Users moved to
  # another drive through a junction); users can't swap the profile folder itself.
  $listedPath = $profilePath
  $profilePath = try { [OpenWhisprNative]::RealPath($profilePath) } catch { $profilePath }
  # Counted per profile, so "Removed" names only profiles where nothing failed.
  $failedBefore = $failed
  # By default only a profile whose path has spaces or non-ASCII characters
  # keeps data in the shared folders (getSafeTempDir, modelDirUtils).
  $failed = $sharedFailed -and $listedPath -notmatch '^[\x21-\x7E]*$'
  # Named after package.json's "name", as Electron names it.
  $userData = Join-Path $profilePath "AppData\Roaming\open-whispr"
  # Marked before anything goes, so a run cut short leaves the app to finish the
  # wipe before it opens (SCRIPT_WIPE_MARKER in localDataWipe.js); a run that
  # finishes takes the mark. One that can't be marked is left as it is.
  $dataFolder = Test-RealFolder $userData $profilePath
  $hadData = $null -ne $dataFolder
  $marker = Join-Path $userData "local-data-wipe.pending"
  if ($hadData) {
    try {
      if (-not $dataFolder) { throw "it is a link or leads out of the profile" }
      # One an earlier run left stays; anything else at its name goes.
      $existing = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
      if ($existing -and ($existing -isnot [IO.FileInfo] -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        Remove-Entry $existing
        $existing = $null
      }
      if (-not $existing) { [IO.File]::Open($marker, "CreateNew").Dispose() }
    } catch {
      Write-Warning "Skipped $($profilePath): it can't be marked for OpenWhispr to finish the wipe ($_)"
      $failed = $true
      continue
    }
  }
  # One profile that stops partway leaves its mark for the app and doesn't stop the rest.
  try {
    $user = Get-ProfileUser $sid
    $audit = Get-AuditLogPath $profilePath $user
    $keptHere = $kept
    # A run again needs the record of what the notes mirror wrote, in the database.
    if (Remove-MirroredFiles $userData $profilePath $listedPath) {
      $keptHere += "transcriptions.db", "transcriptions.db-wal", "transcriptions.db-shm", "transcriptions.db-journal"
    }
    Remove-AllExcept $userData $profilePath $keptHere $audit
    Remove-AllExcept (Join-Path $profilePath ".cache\openwhispr") $profilePath $cacheKept $audit
    $bridge = Join-Path $profilePath ".openwhispr"
    $bridgeFile = Join-Path $bridge "cli-bridge.json"
    if ((Test-ReachedFolder $bridge $profilePath) -and (Test-Path -LiteralPath $bridgeFile -PathType Leaf)) {
      Remove-Entry (Get-Item -LiteralPath $bridgeFile -Force) -Store
    }
    Remove-TempFiles (Join-Path $profilePath "AppData\Local\Temp") $profilePath
    if ($hadData) {
      Write-WipeRecord $user $audit $userData $profilePath $failed
      $existing = Get-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
      if (-not $failed -and $existing) { Remove-Entry $existing }
    }
  } catch {
    Write-Warning "Could not finish the wipe of $($profilePath): $($_.Exception.Message)"
    $failed = $true
  }
  if (-not $failed -and $hadData) { Write-Output "Removed OpenWhispr local data from $profilePath" }
  $failed = $failed -or $failedBefore
}

if ($failed) { exit 1 }
