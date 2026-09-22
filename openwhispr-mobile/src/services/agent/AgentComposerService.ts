import { ApiError } from '@/lib/apiClient';
import { isAccountRequiredError } from '@/lib/accountRequiredError';
import { useConfigStore } from '@/store/useConfigStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import {
  readKeyboardAgentJob,
  writeKeyboardAgentResult,
  isKeyboardAgentCancelled,
} from '@/lib/keyboardAgentSync';
import { StorageService } from '@/services/storage/StorageService';
import { streamAgentText, type AgentMessage } from './AgentStreamClient';
import { buildComposerSystemPrompt } from './composerPrompt';
import type { KeyboardAgentJob } from '@/lib/keyboardAgentSync';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * Maximum in-memory versions per session. Mirrors the App Group cap in
 * keyboardAgentSync (MAX_VERSIONS = 5) so both layers see consistent state.
 */
const MAX_SESSION_VERSIONS = 5;

/**
 * Sliding message window: system prompt + the last MAX_WINDOW_TURNS messages
 * are sent to the model. A turn = one user or assistant message. The full
 * history is retained (and persisted) — only the request payload is trimmed.
 * Pairs are kept intact: if the window would begin on an assistant message it
 * is dropped so the first message is always a user turn.
 */
export const MAX_WINDOW_TURNS = 8;

const REGENERATE_INSTRUCTION = 'Write a different version of the same request.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * In-memory agent session. `latestRequestId` is the timestamp-prefixed id of
 * the most recent generation/action started for this session; it drives the
 * supersede rule for both generateForJob (jobId) and handleAgentAction
 * (requestId).
 */
export interface AgentSession {
  sessionId: string;
  messages: AgentMessage[];
  versions: string[];
  /** Unix ms of the last completed generation. Used for TTL pruning. */
  lastActivityAtMs: number;
  /** Latest requestId (jobId or action requestId) started for this session. */
  latestRequestId: string | null;
  /**
   * AbortController for the in-flight streamAgentText call. Shared across
   * generateForJob and handleAgentAction; a newer request aborts it.
   */
  inFlightController: AbortController | null;
}

/**
 * Serialized session shape (no AbortController). Persisted so keyboard
 * regenerate survives an app kill; rehydrated lazily on access.
 */
export interface PersistedAgentSession {
  sessionId: string;
  messages: AgentMessage[];
  versions: string[];
  lastActivityAtMs: number;
  latestRequestId: string | null;
}

export interface AgentAction {
  type: 'regenerate';
  sessionId: string;
  /** Timestamp-prefixed id (`<ms>-<uuid>`) — same supersede semantics as jobId. */
  requestId: string;
  /** Epoch ms the action was posted (keyboard acceptance keys on updatedAtMs >= atMs). */
  atMs: number;
}

/**
 * Dependencies injected by the caller (Task 9). Keeps the service free of
 * direct native-module imports, which simplifies testing.
 */
export interface AgentComposerConfig {
  /**
   * Writes keyboard status + optional detail string to the App Group.
   * Mirrors the `setKeyboardStatus` closure in useKeyboardHandoff.
   */
  setKeyboardStatus: (status: string, detail?: string) => void;
}

// ---------------------------------------------------------------------------
// Module-level session map (in-memory; persisted via StorageService)
// ---------------------------------------------------------------------------

const sessions = new Map<string, AgentSession>();
let rehydrated = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function toPersisted(session: AgentSession): PersistedAgentSession {
  return {
    sessionId: session.sessionId,
    messages: session.messages,
    versions: session.versions,
    lastActivityAtMs: session.lastActivityAtMs,
    latestRequestId: session.latestRequestId,
  };
}

function persistSessions(): void {
  const payload: PersistedAgentSession[] = [];
  for (const session of sessions.values()) {
    if (!isExpired(session)) payload.push(toPersisted(session));
  }
  try {
    StorageService.saveAgentSessions(payload);
  } catch {
    // Storage quota exceeded or unavailable — persistence failure must not
    // affect protocol behavior (result already written + agent_ready still fires).
    console.warn('[AgentComposerService] Failed to persist agent sessions');
  }
}

/**
 * Merges persisted sessions into the in-memory map the first time the map is
 * accessed in this process. Expired rows are skipped; live in-memory sessions
 * always win over a stored copy.
 */
function ensureRehydrated(): void {
  if (rehydrated) return;
  rehydrated = true;
  const stored = StorageService.loadAgentSessions();
  if (!stored) return;
  for (const persisted of stored) {
    if (sessions.has(persisted.sessionId)) continue;
    if (Date.now() - persisted.lastActivityAtMs > SESSION_TTL_MS) continue;
    sessions.set(persisted.sessionId, { ...persisted, inFlightController: null });
  }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function isExpired(session: AgentSession): boolean {
  return Date.now() - session.lastActivityAtMs > SESSION_TTL_MS;
}

function getSession(sessionId: string): AgentSession | null {
  ensureRehydrated();
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (isExpired(session)) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function createSession(sessionId: string): AgentSession {
  const session: AgentSession = {
    sessionId,
    messages: [],
    versions: [],
    lastActivityAtMs: Date.now(),
    latestRequestId: null,
    inFlightController: null,
  };
  sessions.set(sessionId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Supersede rule (timestamp-prefixed requestId — mirrors useKeyboardHandoff)
// ---------------------------------------------------------------------------

/** Extracts the leading `<ms>` from a `<ms>-<suffix>` id. Null if unparsable. */
function requestTimestampMs(requestId: string | null | undefined): number | null {
  const ms = Number(requestId?.split('-')[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * True when `requestId` is at least as new as the session's latest. Unparsable
 * ids fall back to strict equality, matching the recording-handoff idiom.
 */
function isCurrentRequest(session: AgentSession, requestId: string): boolean {
  const latest = session.latestRequestId;
  if (!latest || latest === requestId) return true;
  const mine = requestTimestampMs(requestId);
  const theirs = requestTimestampMs(latest);
  return mine !== null && theirs !== null && mine >= theirs;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveCustomDictionary(): string[] | undefined {
  const dictState = useDictionaryStore.getState();
  if (!dictState.isLoaded || dictState.entries.length === 0) return undefined;
  return dictState.entries.map((e) => e.word);
}

/**
 * Resolve the language label passed to buildComposerSystemPrompt. Config stores
 * ISO codes (e.g. 'en'); we forward the code directly, matching cleanupTranscript.
 */
function resolveLanguage(): string | undefined {
  const cfg = useConfigStore.getState().config;
  const languages = cfg?.languages;
  if (!languages || languages.length !== 1) return undefined;
  return languages[0];
}

// ---------------------------------------------------------------------------
// Message windowing
// ---------------------------------------------------------------------------

/**
 * Returns the last MAX_WINDOW_TURNS messages, dropping a leading assistant turn
 * so the window always starts on a user message (keeping user→assistant pairs
 * intact). Callers append the new user message before windowing.
 */
function windowMessages(messages: AgentMessage[]): AgentMessage[] {
  const windowed = messages.slice(-MAX_WINDOW_TURNS);
  if (windowed.length > 0 && windowed[0].role === 'assistant') {
    return windowed.slice(1);
  }
  return windowed;
}

// ---------------------------------------------------------------------------
// Shared streaming pipeline
// ---------------------------------------------------------------------------

/** Maps a stream error to a keyboard status. Silent when the call was superseded. */
function reportStreamError(
  err: unknown,
  controller: AbortController,
  setKeyboardStatus: AgentComposerConfig['setKeyboardStatus'],
): void {
  // Own signal aborted ⇒ superseded by a newer call; stay silent so we don't
  // clobber the newer job's status.
  if (controller.signal.aborted) return;
  if (err instanceof ApiError && err.status === 429) {
    setKeyboardStatus('agent_error', 'usage_limit');
    return;
  }
  // An anonymous onboarding session is refused outright; only an account
  // clears it, so the keyboard must not present it as retryable.
  if (isAccountRequiredError(err)) {
    setKeyboardStatus('agent_error', 'account_required');
    return;
  }
  const detail = err instanceof Error ? err.message : 'agent_error';
  setKeyboardStatus('agent_error', detail);
}

/**
 * Streams a completion for a session, then commits it. Handles supersession
 * (abort + shared controller + requestId currency), the sliding window, the
 * version cap, persistence, and terminal status writes.
 *
 * `commit` performs the caller-specific final currency check and result write
 * (job-key check for generateForJob) and returns false to drop silently.
 */
async function runGeneration(params: {
  session: AgentSession;
  requestId: string;
  userMessage: AgentMessage;
  systemPrompt: string;
  setKeyboardStatus: AgentComposerConfig['setKeyboardStatus'];
  commit: (generatedText: string, versions: string[]) => boolean;
}): Promise<void> {
  const { session, requestId, userMessage, systemPrompt, setKeyboardStatus, commit } = params;

  session.inFlightController?.abort();
  session.latestRequestId = requestId;

  const messages: AgentMessage[] = [...session.messages, userMessage];

  const controller = new AbortController();
  session.inFlightController = controller;

  let generatedText: string;
  try {
    generatedText = await streamAgentText({
      messages: windowMessages(messages),
      systemPrompt,
      sessionId: session.sessionId,
      signal: controller.signal,
    });
  } catch (err) {
    if (session.inFlightController === controller) session.inFlightController = null;
    reportStreamError(err, controller, setKeyboardStatus);
    return;
  }

  if (session.inFlightController === controller) session.inFlightController = null;

  if (!isCurrentRequest(session, requestId)) return;

  const versions = [...session.versions, generatedText].slice(-MAX_SESSION_VERSIONS);
  if (!commit(generatedText, versions)) return;

  session.messages = [...messages, { role: 'assistant', content: generatedText }];
  session.versions = versions;
  session.lastActivityAtMs = Date.now();
  persistSessions();

  setKeyboardStatus('agent_ready', undefined);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates agent text for a keyboard agent job (compose / follow_up).
 *
 * compose starts a fresh session; follow_up requires a live one. The job's
 * `jobId` doubles as its requestId for the supersede rule. On success the
 * result is written to the App Group and the session history is extended.
 * Errors set agent_error (429 → usage_limit; superseded abort → silent).
 */
export async function generateForJob(
  job: KeyboardAgentJob,
  instruction: string,
  config: AgentComposerConfig,
): Promise<void> {
  const { setKeyboardStatus } = config;
  const { jobId, sessionId, kind, tone, selectedText, contextBefore, contextAfter } = job;

  let session: AgentSession;
  if (kind === 'compose') {
    // compose always gets a fresh session (idempotent: overwrite any stale one).
    sessions.get(sessionId)?.inFlightController?.abort();
    session = createSession(sessionId);
  } else {
    const existing = getSession(sessionId);
    if (!existing) {
      setKeyboardStatus('agent_error', 'session_expired');
      return;
    }
    session = existing;
  }

  const userMessage: AgentMessage =
    kind === 'follow_up'
      ? { role: 'user', content: `Revise your latest version: ${instruction}` }
      : { role: 'user', content: instruction };

  const systemPrompt = buildComposerSystemPrompt({
    tone,
    customDictionary: resolveCustomDictionary(),
    contextBefore,
    contextAfter,
    selectedText,
    language: resolveLanguage(),
  });

  await runGeneration({
    session,
    requestId: jobId,
    userMessage,
    systemPrompt,
    setKeyboardStatus,
    commit: (_text, versions) => {
      // Pre-write cancel checkpoint: the user tapped X on the "Writing" pill.
      // Drop the result before writing so the keyboard never shows a card for a
      // cancelled compose (the keyboard also rejects a late agent_ready by job).
      if (isKeyboardAgentCancelled()) return false;
      const currentJob = readKeyboardAgentJob(jobId);
      if (!currentJob || currentJob.jobId !== jobId) return false;
      writeKeyboardAgentResult({
        sessionId,
        jobId,
        versions,
        activeIndex: versions.length - 1,
      });
      return true;
    },
  });
}

/**
 * Handles a one-shot keyboard action (regenerate). Appends an imperative asking
 * for a different version, streams under the session's system prompt params,
 * pushes a new version, and writes the result with `jobId = action.requestId`
 * and the original sessionId (the keyboard keys acceptance on updatedAtMs).
 *
 * Missing/expired session → agent_error/session_expired (no stream). Errors map
 * exactly like generateForJob. The requestId participates in the supersede rule.
 */
export async function handleAgentAction(
  action: AgentAction,
  config: AgentComposerConfig,
): Promise<void> {
  const { setKeyboardStatus } = config;
  const { sessionId, requestId } = action;

  const session = getSession(sessionId);
  if (!session) {
    setKeyboardStatus('agent_error', 'session_expired');
    return;
  }

  if (!isCurrentRequest(session, requestId)) return;

  setKeyboardStatus('agent_generating', undefined);

  const systemPrompt = buildComposerSystemPrompt({
    tone: undefined,
    customDictionary: resolveCustomDictionary(),
    language: resolveLanguage(),
  });

  await runGeneration({
    session,
    requestId,
    userMessage: { role: 'user', content: REGENERATE_INSTRUCTION },
    systemPrompt,
    setKeyboardStatus,
    commit: (_text, versions) => {
      // Pre-write cancel checkpoint: X on the "Writing" pill during a regenerate.
      // Drop before writing so a cancelled action never re-shows the card (the
      // keyboard also rejects a late agent_ready for this session/action).
      if (isKeyboardAgentCancelled()) return false;
      writeKeyboardAgentResult({
        sessionId,
        jobId: requestId,
        versions,
        activeIndex: versions.length - 1,
      });
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Utility exports (tests + Task 9 cleanup)
// ---------------------------------------------------------------------------

/** Removes a session from the in-memory map and re-persists. */
export function clearSession(sessionId: string): void {
  if (sessions.delete(sessionId)) persistSessions();
}

/**
 * Clears every session — in-memory and persisted (sign-out / delete-account, so
 * one user's instructions + generated text never leak to the next). Resets the
 * rehydration guard so a later session doesn't re-merge the dropped rows.
 */
export function clearAllSessions(): void {
  sessions.clear();
  rehydrated = false;
  try {
    StorageService.clearAgentSessions();
  } catch {
    console.warn('[AgentComposerService] Failed to clear persisted agent sessions');
  }
}

export function getActiveSession(sessionId: string): AgentSession | null {
  return getSession(sessionId);
}
