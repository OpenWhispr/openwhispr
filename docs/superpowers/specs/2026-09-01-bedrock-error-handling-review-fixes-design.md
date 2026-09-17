# Bedrock Error-Handling Review Fixes Design

**Date:** 2026-09-01

**Status:** Approved for implementation

## Goal

Close the six findings from the fresh read-only review of commit `ddf983fd` without changing the established Bedrock messages, retry count, AWS region, fallback-toast hierarchy, or non-Bedrock behavior.

## Binding requirements

1. Retry retryable 503, 429, timeout, and safe network failures with exponential backoff and random jitter, using six total attempts.
2. Never automatically retry authentication, permission, invalid-model, configuration, or user-cancellation failures.
3. Never silently switch AWS regions.
4. Unwrap `RetryError.lastError` before classification.
5. Preserve HTTP status, AWS exception type, AWS request ID, and the underlying error.
6. Preserve the exact existing primary messages for Bedrock 503, 429, and timeout failures.
7. Keep authentication, permission, model, and configuration failures specific and actionable.
8. Show “Original dictation pasted without AI cleanup.” only after cleanup fails and the original text is actually pasted.
9. Keep the fallback status visually quieter and separate from the primary AWS error.
10. Never show the fallback status during connection tests, after eventual cleanup success, or when no paste occurred.
11. Keep technical details expandable or copyable.
12. Cover both “Check connection” and dictation cleanup.

## Review findings to close

- Cancellation must abort in-flight Bedrock cleanup and retry backoff in the main process, rather than merely discarding the eventual renderer result.
- “Check connection” must use a bounded application timeout.
- Credential-provider failures must cross the real AI SDK boundary without losing their type, status, request ID, cause, or managed/manual context.
- Managed Bedrock error copy must use the resolved runtime region.
- The paste IPC contract must distinguish a real paste from the onboarding no-op.
- The safe-network allowlist must include `ENETDOWN`, `EHOSTDOWN`, `UND_ERR_HEADERS_TIMEOUT`, and `UND_ERR_BODY_TIMEOUT`; the two Undici timeout codes must retain timeout classification and copy.

## Architecture

Use the existing main-process request registry pattern to own Bedrock cleanup cancellation by renderer sender and request ID. Feed its abort signal into each AI SDK attempt and into the retry delay. Resolve AWS credential providers before constructing the Bedrock AI SDK model so the original AWS/Smithy error remains classifiable, and carry the resolved region into mapping context. Finally, make `paste-text` return an explicit `{ success, pasted }` result so renderer fallback state reflects a completed paste rather than a merely resolved IPC call.

## Scope boundaries

- Do not add region failover.
- Do not change Azure, Vertex, Agent streaming, translation, selection-edit, or non-cleanup dictation routing.
- Do not change the established toast hierarchy or the exact 503/429/timeout strings.
- Do not fix unrelated baseline test pollution in this branch.
