#!/bin/bash
# Removes OpenWhispr's local data from a Mac being offboarded (#3030), for MDM
# tools that run scripts as root (Jamf, Kandji, Intune). Each home's owner's
# OpenWhispr is quit first. The WipeLocalDataOnLaunch device key does the same
# from inside the app.
#
#   wipe-local-data-macos.sh [--include-models] [home ...]
#
# Covers every home under /Users unless homes are named. Downloaded models stay
# unless --include-models is passed. The audit log stays, as does the record of
# the last WipeLocalDataOnLaunch token, so the app doesn't wipe a second time,
# and each home's wipe is recorded there while its account exists.
# See docs/mdm-local-data-wipe.md.

set -eo pipefail

# The same lists as KEPT_USER_DATA_ENTRIES, MODEL_USER_DATA_ENTRIES,
# MODEL_CACHE_ENTRIES and TEMP_PREFIXES in src/helpers/localDataWipe.js.
kept_user_data=(audit meeting-audit-session.json meeting-audit-session.json.tmp local-data-wipe.json local-data-wipe.json.tmp local-data-wipe.pending globe-preference-state.json)
model_user_data=(installed-models.json)
model_cache=(whisper-models parakeet-models diarization-models models whisper-vad embedding-models)
temp_prefixes=(ow- openwhispr- whisper-input- whisper-output- parakeet- enterprise-buffer- enterprise-chunks- kwin-active-class-)
# MACOS_PREFERENCES_DOMAIN in src/helpers/managedDevicePolicy.js.
preferences_domain=com.gizmolabs.openwhispr

# A Jamf Pro policy passes the target volume, the computer name and the user
# name first; its own parameters start at $4, and those left blank arrive empty.
if [[ "${1-}" == / && $# -ge 3 ]]; then shift 3; fi
include_models=false
homes=()
for arg in "$@"; do
  case "$arg" in
    "") ;;
    --include-models) include_models=true ;;
    *)
      [[ -d "$arg" ]] || { echo "No such home: $arg" >&2; exit 1; }
      homes+=("$arg")
      ;;
  esac
done
if [[ ${#homes[@]} -eq 0 ]]; then
  for home in /Users/*; do
    [[ -d "$home/Library/Application Support/OpenWhispr" ]] && homes+=("$home")
  done
fi

# A file that can't go (a locked one, say) is reported and the wipe carries on;
# the script then exits non-zero so the MDM tool shows the device as failed.
failed=0
# Runs a command as the home's owner when run as root, so a link the user
# swaps in mid-run can only reach what they could delete themselves. A home
# whose account is gone has no one left to swap links, so root cleans it.
as_owner_run() {
  if [[ -n "$run_as" ]]; then sudo -u "$run_as" "$@"; else "$@"; fi
}
# The same, on the NUL-separated paths read from stdin, so sudo's log doesn't
# record them (they hold note titles).
as_owner() { as_owner_run xargs -0 "$@"; }

remove() {
  printf '%s\0' "$1" | as_owner rm -rf 2>/dev/null || {
    echo "Could not remove $1" >&2
    failed=1
  }
}

contains() {
  local item="$1" entry
  shift
  for entry in "$@"; do
    [[ "$entry" == "$item" ]] && return 0
  done
  return 1
}

# Whether a folder really is inside the home: run as root, a symlink the user
# made must never lead the script out of it.
inside_home() {
  local real
  real="$(cd -P "$1" 2>/dev/null && /bin/pwd -P)" || return 1
  [[ "$real" == "$home_real"/* ]]
}

# The app's daily audit files, any OS user's (meetingAuditLog.js).
is_audit_file() { [[ "$1" =~ ^meeting-audit-.+-[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$ ]]; }

# Removes everything in a folder of the home except the names given. An
# AuditLogPath inside it keeps its audit files and the folders on their way;
# everything else there goes. One that is a link, or leads out of the home, is
# skipped and reported.
remove_all_except() {
  local dir="$1" entry name real
  shift
  [[ -e "$dir" || -L "$dir" ]] || return 0
  if [[ ! -d "$dir" || -L "$dir" ]] || ! inside_home "$dir"; then
    echo "Skipped $dir: it is a link or leads out of $home" >&2
    failed=1
    return 0
  fi
  real="$(cd -P "$dir" && /bin/pwd -P)"
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="$(basename "$entry")"
    contains "$name" "$@" && continue
    [[ "$real" == "$audit_real" ]] && is_audit_file "$name" && continue
    if [[ -n "$audit_real" && -d "$entry" && ! -L "$entry" &&
      ("$audit_real" == "$real/$name" || "$audit_real" == "$real/$name"/*) ]]; then
      remove_all_except "$entry"
      continue
    fi
    remove "$entry"
  done
}

# A folder holding nothing but what Finder or Windows Explorer leave behind.
remove_if_emptied() {
  local dir="$1" entry
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    case "$(basename "$entry")" in
      .DS_Store | Thumbs.db | desktop.ini) ;;
      *) return 1 ;;
    esac
  done
  printf '%s\0' "$dir/.DS_Store" "$dir/Thumbs.db" "$dir/desktop.ini" | as_owner rm -f
  printf '%s\0' "$dir" | as_owner rmdir 2>/dev/null
}

# A file's bytes, read as the home's owner.
read_as_owner() { printf '%s\0' "$1" | as_owner cat; }

# In each folder of the home the notes mirror wrote to, the user's chosen ones
# included, removes only the files the app's database records it writing there
# that still hold what it wrote (a BOM and line endings aside, as the app
# reads them), and folders that leaves empty. Anything else, an outside edit
# included, is the user's. The chosen folder itself stays, and nothing is
# reached through a link out of it. While the home's account exists, the
# database and the files are read as its owner, so root never opens one they
# planted. Without one, root reads a copy of the database with its write-ahead
# log, so the rows still in that log count and a journal left beside it is
# replayed only into the copy, never into a file it is a hard link to. A
# recorded file that didn't go, or a record that can't be read, keeps the
# database (keep_database), so a run again still knows which files are the
# mirror's.
remove_mirrored_files() {
  local database="$user_data/transcriptions.db" db snapshot="" suffix read_failed="" before="$failed"
  local rows base rel kind hash file folder real_base real_dir raw plain skipped="" outside=""
  [[ -f "$database" && ! -L "$database" ]] || return 0
  db="$database"
  if [[ -z "$run_as" && $EUID -eq 0 ]]; then
    snapshot="$(mktemp -d)"
    # Never left behind, even by a run that is stopped.
    trap 'rm -rf "$snapshot"' EXIT
    db="$snapshot/transcriptions.db"
    for suffix in "" -wal -journal; do
      [[ -f "$database$suffix" && ! -L "$database$suffix" ]] || continue
      cp "$database$suffix" "$db$suffix" || read_failed=1
    done
  fi
  # A version from before the mirror kept its record names no file. Not
  # read-only: macOS's sqlite3 can't open a WAL database that way once its app
  # has closed it.
  [[ -z "$read_failed" ]] && rows="$(as_owner_run sqlite3 "$db" \
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_mirror_files'")" &&
    { [[ -z "$rows" ]] || rows="$(as_owner_run sqlite3 -ascii "$db" \
      "SELECT base_path, rel_path, kind, content_hash FROM note_mirror_files ORDER BY base_path")"; } ||
    read_failed=1
  [[ -z "$snapshot" ]] || { rm -rf "$snapshot" && trap - EXIT; }
  if [[ -n "$read_failed" ]]; then
    echo "Could not read the notes mirror's record in $database" >&2
    failed=1
    keep_database=1
    return 0
  fi
  while IFS=$'\x1f' read -r -d $'\x1e' base rel kind hash; do
    [[ "$base" == /* ]] || continue
    # Run as root, the script never leaves the home, not even to look: a notes
    # folder outside it, by its path as recorded (a real path, so with no "." or
    # ".." in it), is reported for you to clean, and the database still goes,
    # since keeping it would keep every note.
    if [[ "$base" != "$home_real"/* || "$base/" == */../* || "$base/" == */./* ]]; then
      [[ "$base" == "$outside" ]] || echo "Skipped $base: it is outside $home" >&2
      outside="$base"
      continue
    fi
    real_base="$(cd -P "$base" 2>/dev/null && pwd)" || continue
    # The record names the folder by its real path: one that now leads
    # elsewhere (a link put in its place) isn't the folder the mirror wrote to.
    if [[ "$real_base" != "$base" ]]; then
      [[ "$base" == "$skipped" ]] || echo "Skipped $base: it now leads elsewhere" >&2
      skipped="$base"
      failed=1
      continue
    fi
    file="$base/$rel"
    if [[ "$kind" == dir ]]; then
      # A folder directory it made, gone with the folders below once empty.
      [[ "$(cd -P "$file" 2>/dev/null && pwd)" == "$file" ]] || continue
      folder="$file"
    else
      real_dir="$(cd -P "$(dirname "$file")" 2>/dev/null && pwd)" || continue
      [[ "$real_dir" == "$real_base" || "$real_dir" == "$real_base"/* ]] || continue
      [[ -f "$file" && ! -L "$file" ]] || continue
      # One it can't read may still hold what it wrote: a failure, not an edit.
      raw="$(read_as_owner "$file" | openssl dgst -sha256 -r)" &&
        plain="$(read_as_owner "$file" | LC_ALL=C sed $'1s/^\xef\xbb\xbf//; s/\r$//' | openssl dgst -sha256 -r)" || {
        echo "Could not read $file" >&2
        failed=1
        continue
      }
      [[ "$hash" == "${raw%% *}" || "$hash" == "${plain%% *}" ]] || continue
      remove "$file"
      folder="$(dirname "$file")"
    fi
    while [[ "$folder" == "$base"/* ]] && remove_if_emptied "$folder"; do
      folder="$(dirname "$folder")"
    done
  done <<<"$rows"
  [[ "$failed" == "$before" ]] || keep_database=1
  [[ -z "$outside" ]] || failed=1
}

remove_temp_files() {
  local dir="$1" entry name prefix
  [[ -d "$dir" ]] || return 0
  for entry in "$dir"/*; do
    name="$(basename "$entry")"
    for prefix in "${temp_prefixes[@]}"; do
      if [[ "$name" == "$prefix"* ]]; then
        remove "$entry"
        break
      fi
    done
  done
}

# The app, its helpers and its sidecars (search index, local models) all run
# from inside the app bundle. Only the given user's are quit: someone else
# signed in on this Mac may be recording.
app_processes="OpenWhispr.app/Contents/"
quit_app() {
  pgrep -U "$1" -f "$app_processes" >/dev/null || return 0
  pkill -U "$1" -f "$app_processes" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -U "$1" -f "$app_processes" >/dev/null || return 0
    sleep 1
  done
  pkill -9 -U "$1" -f "$app_processes" || true
}

# AuditLogPath from the managed preferences, the user's own before the
# device's, as the app reads it; nothing when it is unset or not absolute.
configured_audit_dir() {
  local plist value
  for plist in "/Library/Managed Preferences/$1/$preferences_domain" \
    "/Library/Managed Preferences/$preferences_domain"; do
    value="$(defaults read "$plist" AuditLogPath 2>/dev/null)" || continue
    [[ "$value" != /* ]] || echo "$value"
    return 0
  done
}

# Appends $3 to the daily file $2 in folder $1 as the app does
# (meetingAuditLog.js): never through a link, and only to a regular file the
# writer owns that has no other name. A FIFO planted there can't hold the open.
append_audit_line='
  zmodload zsh/system zsh/stat && mkdir -p -- "$1" || exit 1
  sysopen -a -o creat,nofollow,nonblock -m 644 -u fd -- "$1/$2" || exit 1
  zstat -H st -f $fd || exit 1
  (( st[nlink] == 1 && st[uid] == EUID && (st[mode] & 8#170000) == 8#100000 )) || exit 1
  print -r -u $fd -- "$3"'

# Records the home's wipe in its user's audit log as the app records its own:
# one line in their daily file, in AuditLogPath or else the audit folder the
# wipe keeps, written as them. A home whose account is gone isn't recorded:
# only root could write there, through any link left in it.
record_wipe() {
  local user="$1" configured="$2" ts reason=null line dir
  [[ -n "$run_as" || $EUID -ne 0 ]] || return 0
  [[ "$user" =~ ^[A-Za-z0-9._-]+$ ]] || user=unknown
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  [[ "$failed" == 0 ]] || reason='"incomplete"'
  line="$(printf '{"ts":"%s","event":"local-data.wiped","sessionId":null,"noteId":null,"trigger":"script","reason":%s,"durationSec":null,"participantsNotified":null,"notificationMethod":null,"externalAttendees":null,"appVersion":null,"deviceUser":"%s"}' \
    "$ts" "$reason" "$user")"
  for dir in ${configured:+"$configured"} "$user_data/audit"; do
    as_owner_run /bin/zsh -fc "$append_audit_line" zsh "$dir" \
      "meeting-audit-$user-${ts:0:10}.jsonl" "$line" 2>/dev/null && return 0
  done
  echo "Could not record the wipe in the audit log for $home" >&2
  failed=1
}

console_user=""
[[ $EUID -eq 0 ]] && console_user="$(stat -f %Su /dev/console)"

kept=("${kept_user_data[@]}")
cache_kept=()
if [[ "$include_models" == false ]]; then
  kept+=("${model_user_data[@]}")
  cache_kept=("${model_cache[@]}")
fi

for home in "${homes[@]}"; do
  # Spelled as the disk does, as the app's database records its paths, however
  # the home was typed.
  home_real="$(cd -P "$home" 2>/dev/null && /bin/pwd -P)" || continue
  owner_uid="$(stat -f %u "$home_real")" || continue
  run_as=""
  if [[ $EUID -eq 0 ]]; then
    # A root-owned folder in /Users (like /Users/Shared) is no one's home, and
    # anyone may write in it.
    if [[ "$owner_uid" == 0 ]]; then
      echo "Skipped $home: it belongs to root, not to a user" >&2
      failed=1
      continue
    fi
    id -un "$owner_uid" >/dev/null 2>&1 && run_as="#$owner_uid"
  fi
  # Counted per home, so "Removed" names only homes where nothing failed.
  failed_before="$failed"
  failed=0
  keep_database=0
  user="$(id -un "$owner_uid" 2>/dev/null)" || user=""
  quit_app "$owner_uid"
  user_data="$home/Library/Application Support/OpenWhispr"
  # Marked before anything goes, so a run cut short leaves the app to finish
  # the wipe before it opens (SCRIPT_WIPE_MARKER in localDataWipe.js); a run
  # that finishes takes the mark. A home whose account is gone has no one to
  # open it. One that can't be marked is left as it is.
  marked=0
  if [[ (-n "$run_as" || $EUID -ne 0) && (-e "$user_data" || -L "$user_data") ]]; then
    if [[ -d "$user_data" && ! -L "$user_data" ]] && inside_home "$user_data" &&
      printf '%s\0' "$user_data/local-data-wipe.pending" | as_owner touch; then
      marked=1
    else
      echo "Skipped $home: it can't be marked for OpenWhispr to finish the wipe" >&2
      failed=1
      continue
    fi
  fi
  audit_dir="$(configured_audit_dir "$user")"
  audit_real=""
  [[ -z "$audit_dir" ]] || audit_real="$(cd -P "$audit_dir" 2>/dev/null && /bin/pwd -P)" || audit_real=""
  remove_mirrored_files
  kept_here=("${kept[@]}")
  [[ "$keep_database" == 0 ]] ||
    kept_here+=(transcriptions.db transcriptions.db-wal transcriptions.db-shm transcriptions.db-journal)
  remove_all_except "$user_data" "${kept_here[@]}"
  remove_all_except "$home/.cache/openwhispr" "${cache_kept[@]}"
  inside_home "$home/.openwhispr" && remove "$home/.openwhispr/cli-bridge.json"

  # The keychain item and the per-user temp folder are reachable only as the
  # signed-in user.
  if [[ -n "$console_user" && "$console_user" != root && "$owner_uid" == "$(id -u "$console_user")" ]]; then
    uid="$(id -u "$console_user")"
    launchctl asuser "$uid" sudo -u "$console_user" \
      security delete-generic-password -s OpenWhispr -a secrets-master-key >/dev/null 2>&1 || true
    remove_temp_files "$(launchctl asuser "$uid" sudo -u "$console_user" getconf DARWIN_USER_TEMP_DIR)"
  fi
  # The mark goes only once the audit line is written: one that isn't leaves
  # the app to finish the wipe and record it.
  [[ ! -d "$user_data" ]] || record_wipe "$user" "$audit_dir"
  [[ "$marked" == 0 || "$failed" == 1 ]] || remove "$user_data/local-data-wipe.pending"
  [[ "$failed" == 1 || ! -d "$user_data" ]] || echo "Removed OpenWhispr local data from $home"
  [[ "$failed_before" == 0 ]] || failed=1
done

exit "$failed"
