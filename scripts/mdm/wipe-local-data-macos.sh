#!/bin/bash
# Removes OpenWhispr's local data from a Mac being offboarded (#3030), for MDM
# tools that run scripts as root (Jamf, Kandji, Intune). OpenWhispr is quit
# first. The WipeLocalDataOnLaunch device key does the same from inside the app.
#
#   wipe-local-data-macos.sh [--include-models] [home ...]
#
# Covers every home under /Users unless homes are named. Downloaded models stay
# unless --include-models is passed. The audit log stays, as does the record of
# the last WipeLocalDataOnLaunch token, so the app doesn't wipe a second time.
# See docs/mdm-local-data-wipe.md.

set -eo pipefail

# The same lists as KEPT_USER_DATA_ENTRIES, MODEL_USER_DATA_ENTRIES,
# MODEL_CACHE_ENTRIES and TEMP_PREFIXES in src/helpers/localDataWipe.js.
kept_user_data=(audit meeting-audit-session.json meeting-audit-session.json.tmp local-data-wipe.json)
model_user_data=(installed-models.json)
model_cache=(whisper-models parakeet-models diarization-models models whisper-vad embedding-models)
temp_prefixes=(ow- openwhispr- whisper-input- whisper-output- parakeet- enterprise-buffer- enterprise-chunks- kwin-active-class-)

include_models=false
homes=()
for arg in "$@"; do
  case "$arg" in
    --include-models) include_models=true ;;
    *) homes+=("$arg") ;;
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
  real="$(cd -P "$1" 2>/dev/null && pwd)" || return 1
  [[ "$real" == "$home_real"/* ]]
}

# Removes everything in a folder of the home except the names given.
remove_all_except() {
  local dir="$1" entry
  shift
  [[ -d "$dir" && ! -L "$dir" ]] && inside_home "$dir" || return 0
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    contains "$(basename "$entry")" "$@" || remove "$entry"
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
# reached through a link out of it. The database and the files are read as the
# home's owner, so root never opens one a user planted. The mirror's default
# folder, in the app's own data, goes whole below.
remove_mirrored_files() {
  local database="$user_data/transcriptions.db" data_real rows base rel hash file folder
  local last_base="" real_base="" real_dir raw plain
  [[ -f "$database" && ! -L "$database" ]] || return 0
  data_real="$(cd -P "$user_data" && pwd)" || return 0
  # A version from before the mirror kept its record names no file. Not
  # read-only: macOS's sqlite3 can't open a WAL database that way once its app
  # has closed it.
  rows="$(as_owner_run sqlite3 "$database" \
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_mirror_files'")" &&
    { [[ -z "$rows" ]] || rows="$(as_owner_run sqlite3 -ascii "$database" \
      "SELECT base_path, rel_path, content_hash FROM note_mirror_files WHERE kind != 'dir' ORDER BY base_path")"; } || {
    echo "Could not read the notes mirror's record in $database" >&2
    failed=1
    return 0
  }
  while IFS=$'\x1f' read -r -d $'\x1e' base rel hash; do
    if [[ "$base" != "$last_base" ]]; then
      last_base="$base"
      real_base="$(cd -P "$base" 2>/dev/null && pwd)" || real_base=""
      [[ "$base" == /* && "$real_base" == "$home_real"/* && "$real_base" != "$data_real"/* ]] ||
        real_base=""
    fi
    [[ -n "$real_base" ]] || continue
    file="$base/$rel"
    real_dir="$(cd -P "$(dirname "$file")" 2>/dev/null && pwd)" || continue
    [[ "$real_dir" == "$real_base" || "$real_dir" == "$real_base"/* ]] || continue
    [[ -f "$file" && ! -L "$file" ]] || continue
    raw="$(read_as_owner "$file" | openssl dgst -sha256 -r)" &&
      plain="$(read_as_owner "$file" | LC_ALL=C sed $'1s/^\xef\xbb\xbf//; s/\r$//' | openssl dgst -sha256 -r)" ||
      continue
    [[ "$hash" == "${raw%% *}" || "$hash" == "${plain%% *}" ]] || continue
    remove "$file"
    folder="$(dirname "$file")"
    while [[ "$folder" == "$base"/* ]] && remove_if_emptied "$folder"; do
      folder="$(dirname "$folder")"
    done
  done <<<"$rows"
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
# from inside the app bundle.
app_processes="OpenWhispr.app/Contents/"
if pgrep -f "$app_processes" >/dev/null; then
  pkill -f "$app_processes" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$app_processes" >/dev/null || break
    sleep 1
  done
  pkill -9 -f "$app_processes" || true
fi

console_user=""
[[ $EUID -eq 0 ]] && console_user="$(stat -f %Su /dev/console)"

kept=("${kept_user_data[@]}")
cache_kept=()
if [[ "$include_models" == false ]]; then
  kept+=("${model_user_data[@]}")
  cache_kept=("${model_cache[@]}")
fi

for home in "${homes[@]}"; do
  home_real="$(cd -P "$home" 2>/dev/null && pwd)" || continue
  owner_uid="$(stat -f %u "$home_real")" || continue
  run_as=""
  if [[ $EUID -eq 0 ]]; then
    # A root-owned folder in /Users (like /Users/Shared) is no one's home, and
    # anyone may write in it.
    if [[ "$owner_uid" == 0 ]]; then
      echo "Skipped $home: it belongs to root, not to a user" >&2
      continue
    fi
    id -un "$owner_uid" >/dev/null 2>&1 && run_as="#$owner_uid"
  fi
  user_data="$home/Library/Application Support/OpenWhispr"
  remove_mirrored_files
  remove_all_except "$user_data" "${kept[@]}"
  remove_all_except "$home/.cache/openwhispr" "${cache_kept[@]}"
  inside_home "$home/.openwhispr" && remove "$home/.openwhispr/cli-bridge.json"
  echo "Removed OpenWhispr local data from $home"

  # The keychain item and the per-user temp folder are reachable only as the
  # signed-in user.
  if [[ -n "$console_user" && "$console_user" != root && "$home" == "/Users/$console_user" ]]; then
    uid="$(id -u "$console_user")"
    launchctl asuser "$uid" sudo -u "$console_user" \
      security delete-generic-password -s OpenWhispr -a secrets-master-key >/dev/null 2>&1 || true
    remove_temp_files "$(launchctl asuser "$uid" sudo -u "$console_user" getconf DARWIN_USER_TEMP_DIR)"
  fi
done

exit "$failed"
