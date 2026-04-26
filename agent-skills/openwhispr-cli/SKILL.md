---
name: openwhispr-cli
description: Use this skill whenever the user wants to operate on OpenWhispr notes, folders, transcriptions, or meeting recordings from a terminal or shell. The OpenWhispr CLI (`openwhispr` binary, npm package `@openwhispr/cli`) talks to either the local desktop app or the cloud API and exposes every operation needed for managing notes, folders, transcriptions, audio, the composite end-of-meeting workflow, plus auth and config. Trigger this skill when the user mentions "openwhispr cli", running shell commands against OpenWhispr, automating note workflows, finalizing a meeting, cleaning up a transcription, building agent integrations against OpenWhispr, or scripting any OpenWhispr operation — even if they don't say "CLI" explicitly.
---

# OpenWhispr CLI

Use this reference when running the `openwhispr` command-line tool. The CLI is a single binary that operates against either the local desktop app (via a loopback HTTP bridge) or the cloud REST API. The same command works against both backends.

## Install

```bash
npm install -g @openwhispr/cli
```

Requires Node.js 20 or later. Verify with `openwhispr --version`. If the user reports `command not found`, ensure their npm global bin is on `$PATH`.

## Backends

Every command runs against one of two backends. The behavior is identical from the user's perspective — only the data source differs.

| Backend | What it talks to | Use when |
|---------|------------------|----------|
| **local** | Desktop app's loopback HTTP bridge on `127.0.0.1` | The desktop app is running. Authoritative during/right after a recording. |
| **remote** | `https://api.openwhispr.com/api/v1` | Desktop is closed, or running on a different machine, or the user wants cloud-side semantics. |

### How the CLI picks a backend

Resolution order (first match wins):

1. The `--local` or `--remote` flag on the command
2. The `OPENWHISPR_BACKEND` environment variable (`local`, `remote`, or `auto`)
3. The `backend` key in `~/.openwhispr/cli-config.json`
4. Auto-detect: local if the desktop bridge is reachable, otherwise remote if an API key is configured, otherwise error with guidance

### Local backend (no setup needed)

When the desktop app starts, it writes `{version, port, token}` to `~/.openwhispr/cli-bridge.json` with mode `0600`. The CLI reads it automatically. If the file is missing or stale, local is treated as unavailable.

### Remote backend (needs an API key)

Generate a key in the desktop app under **Integrations > API Keys**, then run:

```bash
openwhispr auth login    # prompts for the key, stores it 0600 in ~/.openwhispr/cli-config.json
openwhispr auth status   # confirm it works
openwhispr auth logout   # clear it
```

API keys are scoped server-side. Match scopes to the commands the user needs to run:

| Scope | Commands |
|-------|----------|
| `notes:read` | `notes list/get/search`, `folders list` |
| `notes:write` | `notes create/update/delete`, `folders create` |
| `transcriptions:read` | `transcriptions list/get` |
| `transcriptions:delete` | `transcriptions delete`, `meeting finalize` |
| `meetings:finalize` | `meeting finalize` |
| `usage:read` | (used internally by `auth status` for the remote ping) |

## Output

The CLI auto-detects whether stdout is a TTY:

- TTY → human-readable (table for lists, markdown or rendered for single resources)
- Pipe/redirect → JSON

Override with `--format json|table|markdown`. Always pass `--format json` when parsing CLI output programmatically.

## Exit codes

Honor these exit codes when scripting or recovering from errors:

| Code | Meaning | Recovery |
|------|---------|----------|
| 0 | Success | Continue |
| 1 | User error (bad args, missing required flag) | Fix the command and rerun |
| 2 | Backend unreachable | Start the desktop app, or run `auth login` for cloud, or try `--remote`/`--local` explicitly |
| 3 | Auth failure (missing/invalid key, insufficient scope) | Do not retry — surface to the user |
| 4 | Not found (no such note/transcription/folder) | Check the ID and rerun |
| 5 | Safety gate refused (e.g. `meeting finalize` could not verify the new note) | Do not retry — investigate first |

## Commands

Noun-verb syntax: `openwhispr <noun> <verb>`. Same convention as `gh`, `kubectl`, `aws`, `stripe`.

### Notes

```bash
openwhispr notes list [--folder <id>] [--limit N]
openwhispr notes get <id> [--format json|markdown]
openwhispr notes create --content <text> | --content-file <path>
                        [--title <t>] [--folder <id>]
                        [--source-transcription <id>]
openwhispr notes update <id> [--content <t>] [--folder <id>] [--title <t>]
openwhispr notes delete <id>
openwhispr notes search <query> [--limit N]
```

`--source-transcription` links a note to the transcription it was generated from. Required by `meeting finalize`'s safety gate; useful in general for traceability.

### Folders

```bash
openwhispr folders list
openwhispr folders create --name <name> [--sort-order <n>]
```

Folder names must be unique per user. Create returns 409-equivalent on duplicates (exit code 1 with a clear message).

### Transcriptions

```bash
openwhispr transcriptions list [--limit N]
openwhispr transcriptions get <id> [--format json|text|srt|vtt]
openwhispr transcriptions delete <id>
```

`text|srt|vtt` formats are remote-only and require segment data on the transcription. `text` works whenever there's a transcript; `srt` and `vtt` need word-level timestamps.

### Audio

```bash
openwhispr audio delete <transcription-id>
```

Local-only. The cloud API does not store audio. Running this with `--remote` returns a clear "not supported" error (exit 1).

### Meeting

```bash
openwhispr meeting finalize --transcription <id>
                            --folder <id>
                            --content-file <path>
                            [--title <t>]
                            [--dry-run]
                            [--format json]
```

Composite operation: creates a note from the transcription, verifies it landed in the requested folder linked to the transcription via `source_transcription_id`, then deletes the transcription and audio. **This is destructive — the raw transcript and audio are gone afterward.** Use `--dry-run` first to validate without deleting. See the **Workflows** section below.

### Auth

```bash
openwhispr auth login    # prompts for API key
openwhispr auth status
openwhispr auth logout
```

### Config

```bash
openwhispr config get
openwhispr config set backend auto|local|remote
openwhispr config set api-base https://api.openwhispr.com
```

`api-base` is overridable for self-hosted or staging deployments. Default is the production cloud.

### Doctor

```bash
openwhispr doctor [--format json]
```

Probes both backends and reports each independently. Exit 0 if at least one is reachable; exit 2 if neither. Run this first when the user reports "the CLI isn't working" — it isolates whether the problem is the desktop bridge, the API key, or something else.

### Version

```bash
openwhispr --version    # or: openwhispr version
```

## Workflows

### Finalizing a meeting (the destructive composite)

When a meeting recording has finished and the user has confirmed the polished note content + target folder, use `meeting finalize`. The safety gate prevents deleting the transcription unless the note successfully landed.

**Prerequisites — confirm all of these before running:**

1. The recording has finished (the transcription appears in `openwhispr transcriptions list`).
2. The polished note content is ready, written to a temp file.
3. The user has chosen a folder and confirmed the destination.
4. The user has agreed to discard the raw transcription + audio. This is destructive — point it out explicitly if there's any ambiguity.

**Step 1 — dry-run** to surface problems without deleting anything:

```bash
openwhispr meeting finalize \
  --transcription <transcription-id> \
  --folder <folder-id> \
  --content-file <path-to-temp-content> \
  --title "<title>" \
  --dry-run --format json
```

If the exit code is non-zero, stop and report the error. Do not retry.

**Step 2 — execute for real:**

```bash
openwhispr meeting finalize \
  --transcription <transcription-id> \
  --folder <folder-id> \
  --content-file <path-to-temp-content> \
  --title "<title>" \
  --format json
```

The response prints `note_id`. Confirm with `openwhispr notes get <note-id> --format json` — verify `folder_id` matches the user's choice and `source_transcription_id` matches the transcription you finalized.

**Idempotency:** if the create succeeds but the delete fails, the note exists and the transcription is intact. Re-running with the same arguments will detect the existing note (linked via `source_transcription_id`), skip the create, and complete the delete. This is safe.

**Hard rules:**

- Do not compose `notes create` + `transcriptions delete` by hand. Always use `meeting finalize` — the composite has the safety gate; the two-step does not.
- Do not retry destructive commands on failure. Surface the exit code and stderr to the user.
- During an active meeting window (recording just finished, sync hasn't reconciled yet), prefer `--local`. The local SQLite is authoritative.

### Bulk note operations

Pipe `notes list --format json` through `jq` for filtering, then iterate:

```bash
openwhispr notes list --limit 100 --format json | \
  jq -r '.data[] | select(.title | contains("draft")) | .id' | \
  while read id; do
    openwhispr notes delete "$id"
  done
```

### Searching for context before writing a note

```bash
openwhispr notes search "quarterly budget" --format json | jq '.data[].id'
```

Use the IDs returned to read related notes with `notes get` before composing the new note's content.

## Configuration files

The CLI reads/writes these files. Both should always be `0600`.

| File | Written by | Contains |
|------|-----------|----------|
| `~/.openwhispr/cli-bridge.json` | The desktop app at startup | `{version, port, token}` for the loopback bridge |
| `~/.openwhispr/cli-config.json` | The CLI's `auth login` and `config set` | `{backend, apiBase, apiKey}` |

If either file's permissions are looser than `0600`, the CLI will warn but still operate. Tighten them with `chmod 0600 <file>`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Backend unreachable` (exit 2) on every command | Desktop closed and no API key | Start desktop, or `openwhispr auth login` |
| `Auth failed` (exit 3) on remote commands only | API key revoked, expired, or missing scope | Regenerate key with the right scopes |
| `Not found` (exit 4) on a known-existing note | Wrong backend — the note is on the other side, not yet synced | Try the opposite backend (`--local` or `--remote`) |
| `Safety gate refused` (exit 5) on `meeting finalize` | The note didn't land in the target folder | Don't retry — check folder ID and re-examine |
| `0o600` permission warning at startup | Config file is too permissive | `chmod 0600 ~/.openwhispr/cli-config.json` |

## Programmatic invocation

When invoking from another program, always pass `--format json` and parse the output. Inspect exit code first; on non-zero, the response shape is `{ "error": { "code": "...", "message": "..." } }` matching the cloud REST API and the local bridge.
