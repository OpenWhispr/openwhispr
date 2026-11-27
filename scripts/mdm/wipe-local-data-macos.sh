#!/bin/bash
# Removes OpenWhispr's local data from a Mac being offboarded (#3323), for MDM
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
# whose account is gone is cleaned as root (in_home_folder).
as_owner_run() {
  if [[ -n "$run_as" ]]; then sudo -u "$run_as" "$@"; else "$@"; fi
}
# The same, on the NUL-separated paths read from stdin, so sudo's log doesn't
# record them (they hold note titles).
as_owner() { as_owner_run xargs -0 "$@"; }

# Whether root cleans this home: its account is gone.
as_root() { [[ -z "$run_as" && $EUID -eq 0 ]]; }

# Runs a command as root from inside a folder of the home, once there it is
# sure to be in the home: another user who can write in a home whose account
# is gone could swap a link into a path mid-run, and rm and rmdir act on a
# link they are given, never on what it leads to.
in_home_folder() {
  local dir="$1" real
  shift
  (cd -P "$dir" 2>/dev/null && real="$(/bin/pwd -P)" &&
    [[ "$real" == "$home_real" || "$real" == "$home_real"/* ]] && "$@")
}

remove() {
  if as_root; then
    in_home_folder "${1%/*}" rm -rf -- "./${1##*/}"
  else
    printf '%s\0' "$1" | as_owner rm -rf
  fi 2>/dev/null || {
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
  # One moved away after the check is skipped too, rather than ending the run
  # (set -e) before the homes after this one.
  if [[ ! -d "$dir" || -L "$dir" ]] || ! inside_home "$dir" ||
    ! real="$(cd -P "$dir" 2>/dev/null && /bin/pwd -P)"; then
    echo "Skipped $dir: it is a link or leads out of $home" >&2
    failed=1
    return 0
  fi
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
  if as_root; then
    in_home_folder "$dir" rm -f .DS_Store Thumbs.db desktop.ini &&
      in_home_folder "${dir%/*}" rmdir -- "./${dir##*/}" 2>/dev/null
  else
    printf '%s\0' "$dir/.DS_Store" "$dir/Thumbs.db" "$dir/desktop.ini" | as_owner rm -f
    printf '%s\0' "$dir" | as_owner rmdir 2>/dev/null
  fi
}

# A file's bytes, read as the home's owner, when it holds no more than the
# bytes given ($2). It is opened without waiting and read only as a regular
# file, as the audit writer below opens its file, so a FIFO the user swaps in
# after the checks can't hold the run, nor can a sparse file that takes no room
# but would take days to read. The app can't read a note over 512 MiB either.
# A home's record is bounded too, in files and in what they hold together, so
# one home can't hold up the homes after it for hours.
max_note_bytes=$((512 << 20))
max_database_bytes=$((4 << 30))
max_mirror_rows=50000
max_mirror_bytes=$((4 << 30))
read_regular_file='
  zmodload zsh/system zsh/stat && IFS= read -r -d "" file &&
  sysopen -r -o nofollow,nonblock -u fd -- "$file" && zstat -H st -f $fd &&
  (( (st[mode] & 8#170000) == 8#100000 && st[size] <= $1 )) && head -c "$1" <&$fd'
read_as_owner() { printf '%s\0' "$1" | as_owner_run /bin/zsh -fc "$read_regular_file" zsh "$2"; }

# In each folder of the home the notes mirror wrote to, the user's chosen ones
# included, removes only the files the app's database records it writing there
# that still hold what it wrote (a BOM and line endings aside, as the app
# reads them), and folders that leaves empty. Anything else, an outside edit
# included, is the user's. The chosen folder itself stays, and nothing is
# reached through a link in it. While the home's account exists, the
# database and the files are read as its owner, so root never opens one they
# planted. The database is read from a copy with its write-ahead log, so the
# rows still in that log count. The copy sits in a folder only root can change,
# so its reader can't swap in a FIFO there either; the log and its index are
# made beforehand, since the reader can't make them. A rollback journal beside
# it can't be replayed there, so with one only a database that keeps no record
# at all reads: one from before the mirror, which the app hasn't opened since
# it moved to a write-ahead log. Any other counts as one it can't read.
# A recorded file that didn't go, or a record that can't be read, keeps the
# database (keep_database), so a run again still knows which files are the
# mirror's.
remove_mirrored_files() {
  local database="$user_data/transcriptions.db" db snapshot suffix journal="" read_failed="" before="$failed"
  local rows base rel kind hash file folder real_base real_dir raw plain skipped="" outside="" linked=""
  local size budget="$max_mirror_bytes"
  [[ -f "$database" && ! -L "$database" ]] || return 0
  [[ ! -e "$database-journal" && ! -L "$database-journal" ]] || journal=1
  # In /tmp, where the reader can reach it: without a template, macOS's mktemp
  # makes it in root's own temp folder, which only root can enter. Named by this
  # run's process, so another run never takes it for a leftover (below).
  if snapshot="$(mktemp -d "/tmp/openwhispr-wipe.$$.XXXXXXXX")"; then
    # Never left behind, even by a run that is stopped.
    trap 'rm -rf "$snapshot"' EXIT
    db="$snapshot/transcriptions.db"
    : >"$db-wal" && : >"$db-shm" || read_failed=1
    for suffix in "" -wal; do
      [[ -f "$database$suffix" && ! -L "$database$suffix" ]] || continue
      read_as_owner "$database$suffix" "$max_database_bytes" >"$db$suffix" || read_failed=1
    done
    # Only then can the reader reach the folder, and no one else the copy.
    chmod 600 "$snapshot"/* && chmod 711 "$snapshot" || read_failed=1
    [[ -z "$run_as" ]] || chown "$owner_uid" "$snapshot"/* || read_failed=1
    # A version from before the mirror kept its record names no file, and only
    # a plain table its own SQL names is the app's, never a virtual one whose
    # module would run on a file the user made. Opened read-write, since
    # macOS's sqlite3 can't open a WAL database read-only once its app has
    # closed it, but never created, so a copy gone missing fails.
    [[ -z "$read_failed" ]] && rows="$(as_owner_run sqlite3 -init /dev/null "file:$db?mode=rw" \
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_mirror_files' AND sql GLOB 'CREATE TABLE note_mirror_files[ (]*'")" &&
      { [[ -z "$rows" ]] || { [[ -z "$journal" ]] && rows="$(as_owner_run sqlite3 -init /dev/null -ascii "file:$db?mode=rw" \
        "SELECT base_path, rel_path, kind, content_hash FROM note_mirror_files ORDER BY base_path, rel_path LIMIT $((max_mirror_rows + 1))")"; }; } &&
      { (($(printf '%s' "$rows" | tr -cd '\036' | wc -c) <= max_mirror_rows)) ||
        read_failed=": it lists more than $max_mirror_rows entries"; } ||
      read_failed=1
    rm -rf "$snapshot" && trap - EXIT
  else
    read_failed=1
  fi
  if [[ -n "$read_failed" ]]; then
    echo "Could not read the notes mirror's record in $database${read_failed#1}" >&2
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
    if [[ ("$base" != "$home_real" && "$base" != "$home_real"/*) || "$base/" == */../* || "$base/" == */./* ]]; then
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
    # Never the mirror's: one that leads out through "..".
    [[ "/$rel/" != */../* && "/$rel/" != */./* ]] || continue
    file="$base/$rel"
    if [[ "$kind" == dir ]]; then
      # A folder directory it made, gone with the folders below once empty.
      [[ "$(cd -P "$file" 2>/dev/null && pwd)" == "$file" ]] || continue
      folder="$file"
    else
      real_dir="$(cd -P "${file%/*}" 2>/dev/null && pwd)" || continue
      # A folder on its way that is now a link, which the mirror never writes
      # through: what it leads to stays for you to clean, reported, and the
      # database still goes, as with a notes folder outside the home.
      if [[ "$real_dir" != "${file%/*}" ]]; then
        [[ $'\n'"$linked" == *$'\n'"${file%/*}"$'\n'* ]] || {
          echo "Skipped ${file%/*}: it is reached through a link, so its notes weren't removed" >&2
          linked+="${file%/*}"$'\n'
        }
        continue
      fi
      [[ -f "$file" && ! -L "$file" ]] || continue
      size="$(ls -ln "$file" 2>/dev/null | awk '{ print $5; exit }')" || size=""
      if [[ ! "$size" =~ ^[0-9]+$ ]]; then
        echo "Could not read $file" >&2
        failed=1
        continue
      fi
      if ((size > budget)); then
        echo "Could not read $file: the notes recorded in $home take more than $((max_mirror_bytes >> 30)) GiB together" >&2
        failed=1
        break
      fi
      budget=$((budget - size))
      # One it can't read may still hold what it wrote: a failure, not an edit.
      raw="$(read_as_owner "$file" "$max_note_bytes" | openssl dgst -sha256 -r)" &&
        plain="$(read_as_owner "$file" "$max_note_bytes" | LC_ALL=C sed $'1s/^\xef\xbb\xbf//; s/\r$//' | openssl dgst -sha256 -r)" || {
        echo "Could not read $file" >&2
        failed=1
        continue
      }
      [[ "$hash" == "${raw%% *}" || "$hash" == "${plain%% *}" ]] || continue
      remove "$file"
      folder="${file%/*}"
    fi
    while [[ "$folder" == "$base"/* ]] && remove_if_emptied "$folder"; do
      folder="${folder%/*}"
    done
  done <<<"$rows"
  [[ "$failed" == "$before" ]] || keep_database=1
  [[ -z "$outside" && -z "$linked" ]] || failed=1
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

# Copies of a database left by a run killed while reading it (see
# remove_mirrored_files), never one a run still going reads: in sticky /tmp, a
# user could put a folder of links in its place, which that run would then
# write and chown through as root.
for leftover in /tmp/openwhispr-wipe.*; do
  pid="${leftover#/tmp/openwhispr-wipe.}"
  pid="${pid%%.*}"
  if [[ -d "$leftover" && ! -L "$leftover" && -O "$leftover" && "$pid" =~ ^[0-9]+$ ]] &&
    ! kill -0 "$pid" 2>/dev/null; then rm -rf "$leftover" 2>/dev/null || true; fi
done

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
    # Root cleans a home whose account is gone only while nothing still runs as
    # it, which could swap a link in mid-run.
    if [[ -z "$run_as" ]] && pgrep -u "$owner_uid" >/dev/null; then
      echo "Skipped $home: its account is gone, but processes still run as it" >&2
      failed=1
      continue
    fi
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
