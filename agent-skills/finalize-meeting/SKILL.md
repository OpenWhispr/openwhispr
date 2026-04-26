---
name: finalize-meeting
description: Use this skill at the end of a meeting recording to save the polished meeting note into a folder and clean up the raw transcription and audio. Invoke once the note content is ready and the user has confirmed the target folder. The CLI does the cleanup atomically with a safety gate so the note never goes missing.
---

# Finalize Meeting

Wraps up a finished meeting: writes the processed note into a target folder, verifies it landed correctly, then deletes the source transcription and its audio. Atomic in spirit — if the note can't be verified in the target folder, nothing is deleted and the command exits non-zero.

## When to use

Invoke this **only** when:

1. A meeting recording has finished (the desktop app shows the transcription in the history).
2. You have produced a polished note from the transcription content.
3. The user has confirmed which folder the note should go into.
4. The user has agreed to discard the raw transcription + audio (this is destructive).

If any of those is missing, do not run the command. Ask the user.

## Prerequisites

- The OpenWhispr CLI is installed: `npm install -g @openwhispr/cli`. Check with `openwhispr --version`.
- The desktop app is running (the local backend is the right choice during an active meeting window — local SQLite is authoritative until sync reconciles).
- You know:
  - the **transcription ID** of the meeting that just ended
  - the **folder ID** the user wants the note in
  - the **note content** (write it to a temp file first)

## Steps

### 1. Dry-run first

This catches problems without deleting anything.

```
openwhispr meeting finalize \
  --transcription <transcription-id> \
  --folder <folder-id> \
  --content-file <path-to-temp-content> \
  [--title "<title>"] \
  --dry-run --format json
```

Inspect the JSON. If the exit code is non-zero, **stop** and report the error to the user. Do not retry; investigate first.

### 2. Execute for real

```
openwhispr meeting finalize \
  --transcription <transcription-id> \
  --folder <folder-id> \
  --content-file <path-to-temp-content> \
  [--title "<title>"] \
  --format json
```

### 3. Verify

The command prints `note_id` on success. Confirm:

```
openwhispr notes get <note-id> --format json
```

Check that `folder_id` matches what the user requested and `source_transcription_id` matches the transcription you finalized.

## Error handling

| Exit code | Meaning | What to do |
|-----------|---------|-----------|
| 0 | Success | Done |
| 1 | User error (bad args) | Fix the command and rerun |
| 2 | Backend unreachable | Ask the user to start the desktop app, or run `openwhispr auth login` for cloud access |
| 3 | Auth failure | Do **not** retry. Tell the user the API key is missing/invalid or lacks scope |
| 4 | Not found | The transcription, folder, or note doesn't exist. Ask the user to confirm the IDs |
| 5 | Safety gate refused | The note did not land in the target folder. Do **not** retry. Investigate (folder ID wrong? permission issue?) before deleting anything |

## Hard rules

- **Do not** compose `notes create` + `transcriptions delete` by hand. Always use `meeting finalize`. The composite has the safety gate; the two-step does not.
- **Do not** retry destructive commands on failure. Surface the exit code and stderr to the user.
- **Do not** pass `--remote` while the user's desktop app is running on the same machine, unless the user explicitly asks. The local copy is authoritative during an active meeting window.
- **Do not** finalize a transcription that's still being processed (status `processing`). The command will refuse anyway, but don't try.

## Idempotency

If the create succeeds but the delete fails (network blip, etc.), the note exists and the transcription is intact. Re-running `meeting finalize` with the same transcription ID and the same content will:

- Detect the note already exists (linked via `source_transcription_id`)
- Skip the create
- Complete the delete

This is safe. Other failure modes (auth, validation, not-found) are not idempotent — fix the underlying problem before rerunning.
