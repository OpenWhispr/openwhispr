# Bash exposes the current source filename but keeps no history of sourced files.
# Load the normal login files and remember whether they ran .bashrc, including
# when a profile registers a DEBUG handler of its own.
set -T
__ow_user_debug=-
__ow_observe_source() {
  local __ow_status=$?
  __ow_probe_active=1
  if [[ -z ${__ow_rc_seen:-} && ${BASH_SOURCE[1]:-} -ef "$HOME/.bashrc" ]]; then
    __ow_rc_seen=1
  fi
  # Bash resolves function names after calling DEBUG. Only interpose on the
  # impending trap invocation, so ordinary builtins (e.g. declare or local)
  # still run in the caller's scope. Never save, evaluate or print BASH_COMMAND.
  [[ -n ${FUNCNAME[1]:-} && ${FUNCNAME[1]} != __ow_* ]] || return "$__ow_status"
  case $BASH_COMMAND in
    trap|trap[[:space:]]*)
      if ! declare -F trap >/dev/null; then
        trap() { unset -f trap; __ow_trap "$@"; }
      fi
      ;;
    command[[:space:]]*trap*)
      # Read BASH_COMMAND in this trap's shell. In newer Bash a subshell sees
      # its own command instead of the profile invocation that triggered DEBUG.
      local __ow_prefix __ow_builtin
      if ! declare -F command >/dev/null; then
        for __ow_prefix in command 'command -p' 'command --' 'command -p --'; do
          for __ow_builtin in trap 'builtin trap' 'builtin -- trap'; do
            case $BASH_COMMAND in
              "$__ow_prefix $__ow_builtin"|"$__ow_prefix $__ow_builtin"[[:space:]]*)
                command() {
                  unset -f command
                  while [[ $# -gt 0 && $1 != trap ]]; do shift; done
                  shift
                  __ow_trap "$@"
                }
                break 2
                ;;
            esac
          done
        done
      fi
      ;;
    'builtin trap'|'builtin trap'[[:space:]]*|'builtin -- trap'|'builtin -- trap'[[:space:]]*)
      if ! declare -F builtin >/dev/null; then
        builtin() {
          unset -f builtin
          if [[ ${1:-} == -- ]]; then shift; fi
          if [[ ${1:-} == trap ]]; then shift; __ow_trap "$@"; else command builtin "$@"; fi
        }
      fi
      ;;
  esac
  return "$__ow_status"
}

__ow_trap() {
  if [[ ${1:-} == -- ]]; then shift; fi
  if [[ $# == 0 || ${1:-} == -p ]]; then
    # Report only the hook that the profile installed, including an empty
    # result before its first registration. Some profiles check this first.
    (command builtin trap "$__ow_user_debug" DEBUG; command builtin trap "$@")
    return
  fi
  if (( $# < 2 )) || [[ $1 == -l ]]; then
    command builtin trap "$@"
    return
  fi

  local __ow_action=$1 __ow_signal
  shift
  for __ow_signal in "$@"; do
    if [[ $__ow_signal == DEBUG ]]; then
      __ow_user_debug=$__ow_action
      case $__ow_action in
        -|'') command builtin trap '__ow_observe_source || :' DEBUG ;;
        *) command builtin trap "$__ow_action"$'\n''__ow_observe_source' DEBUG ;;
      esac
    else
      command builtin trap "$__ow_action" "$__ow_signal"
    fi
  done
}

command builtin trap '__ow_observe_source || :' DEBUG
if [[ -r /etc/profile ]]; then . /etc/profile; fi
for __ow_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [[ -f "$__ow_profile" && -r "$__ow_profile" ]]; then
    . "$__ow_profile"
    break
  fi
done

__ow_probe_active=
:
if [[ -n $__ow_probe_active ]]; then
  command builtin trap "$__ow_user_debug" DEBUG
  set +T
else
  # Startup code can explicitly disable function tracing or replace the
  # observer. Preserve its handler when inclusion can no longer be determined.
  __ow_rc_seen=1
fi
