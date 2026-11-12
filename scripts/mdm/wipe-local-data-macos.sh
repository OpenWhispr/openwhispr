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
remove() {
  rm -rf "$1" 2>/dev/null || {
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

# In a folder of the home the user chose for the notes mirror, removes only the
# files the mirror wrote: "<id>-<slug>.md" opening with "---" and "id: <id>",
# their "<id>-...-transcript" companions, and folders that leaves empty. The
# chosen folder itself stays.
remove_mirrored_files() {
  local base="$1" folder file name id head
  local ids=() emptied=()
  [[ -d "$base" ]] && inside_home "$base" || return 0
  for folder in "$base"/*/; do
    [[ -L "${folder%/}" ]] && continue
    for file in "$folder"[0-9]*-*.md; do
      [[ -f "$file" && ! -L "$file" ]] || continue
      name="$(basename "$file")"
      id="${name%%-*}"
      [[ "$id" =~ ^[0-9]+$ ]] || continue
      head="$(head -n 2 "$file" | LC_ALL=C sed $'1s/^\xef\xbb\xbf//' | tr -d '\r')" || continue
      if [[ "$head" == $'---\nid: '"$id" ]]; then
        remove "$file"
        ids+=("$id")
        emptied+=("${folder%/}")
      fi
    done
  done
  for folder in "$base"/*/; do
    [[ -L "${folder%/}" ]] && continue
    for file in "$folder"[0-9]*-*-transcript.md "$folder"[0-9]*-*-transcript.txt; do
      [[ -f "$file" && ! -L "$file" ]] || continue
      name="$(basename "$file")"
      if contains "${name%%-*}" "${ids[@]}"; then
        remove "$file"
        emptied+=("${folder%/}")
      fi
    done
  done
  for folder in "${emptied[@]}"; do
    rmdir "$folder" 2>/dev/null || true
  done
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
  user_data="$home/Library/Application Support/OpenWhispr"
  # Every folder the mirror wrote to, from the app's record of them.
  index=0
  while mirror="$(plutil -extract "basePaths.$index" raw -o - "$user_data/notes-mirror.json" 2>/dev/null)"; do
    [[ "$mirror" == /* ]] && remove_mirrored_files "$mirror"
    index=$((index + 1))
  done
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
