#!/usr/bin/env bash
# with-deploy-key.sh <NAME> <command...>
# Runs a command whose git pushes authenticate with the deploy key held in the environment
# variable NAME, against GitHub's pinned host key. The key file lasts only as long as the
# command does.
set -euo pipefail
name="$1"
shift
if [ -z "${!name:-}" ]; then
  echo "::error::$name is not set"
  exit 1
fi
key="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/deploy-key.XXXXXX")"
hosts="$key.hosts"
trap 'rm -f "$key" "$hosts"' EXIT
printf '%s\n' "${!name}" > "$key"
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" > "$hosts"
GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$hosts" "$@"
