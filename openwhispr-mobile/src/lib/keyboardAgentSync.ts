import { AppState } from 'react-native';
import type { KeyboardTone } from '@/types';
import { DEFAULT_KEYBOARD_TONE } from '@/lib/keyboardTone';
import {
  getDictationAgentName,
  isDictationAgentApplicable,
  isDictationAgentEnabled,
} from '@/lib/dictationAgent';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { randomUUID } from '@/lib/uuid';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// App Group UserDefaults is memory-mapped into the jetsam-constrained keyboard
// extension. Cap each version string and the total payload to keep the key small.
const MAX_VERSIONS = 5;
const MAX_VERSION_CHARS = 2_000; // ~2 KB per version
const MAX_PAYLOAD_CHARS = 8_000; // ~8 KB total safety budget

const FRESH_REQUEST_TTL_MS = 15_000;

export interface KeyboardAgentRequest {
  kind: 'compose' | 'follow_up';
  sessionId?: string;
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  requestedAtMs: number;
}

export interface KeyboardAgentJob {
  jobId: string;
  sessionId: string;
  kind: 'compose' | 'follow_up';
  selectedText?: string;
  contextBefore?: string;
  contextAfter?: string;
  tone: KeyboardTone;
  requestedAtMs: number;
}

export interface KeyboardAgentAction {
  type: 'regenerate';
  sessionId: string;
  requestId: string;
  atMs: number;
}

export interface KeyboardAgentResultInput {
  sessionId: string;
  jobId: string;
  versions: string[];
  activeIndex: number;
}

export interface KeyboardAgentResult extends KeyboardAgentResultInput {
  updatedAtMs: number;
}

function writeAgentMirrorKeys(): void {
  const config = useConfigStore.getState().config;
  const mode = useProcessingModeStore.getState().activeMode;

  const enabled = isDictationAgentEnabled(config ?? { defaultMode: 'cloud' });
  const applicable = isDictationAgentApplicable(mode, config ?? { defaultMode: 'cloud' });
  const name = getDictationAgentName(config ?? { defaultMode: 'cloud' });
  const shareContext = config?.dictationAgentShareContext ?? false;

  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_ENABLED, enabled ? '1' : '0');
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_APPLICABLE, applicable ? '1' : '0');
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_NAME, name);
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_SHARE_CONTEXT, shareContext ? '1' : '0');
}

export function startKeyboardAgentSync(): () => void {
  writeAgentMirrorKeys();

  const unsubConfig = useConfigStore.subscribe(writeAgentMirrorKeys);
  const unsubMode = useProcessingModeStore.subscribe(writeAgentMirrorKeys);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      writeAgentMirrorKeys();
    }
  });

  return () => {
    unsubConfig();
    unsubMode();
    appStateSub.remove();
  };
}

// Reads and validates the one-shot keyboard_agent_request. Returns null on
// absence, invalid JSON, or a stale timestamp (>15s). On any failure the key
// is cleared so a corrupt/stale value doesn't block future requests.
//
// Idempotent per jobId: if the job key already holds a job for this jobId
// (e.g. a second synchronous-turn caller after the request was consumed),
// that job is returned directly without re-consuming the request.
export function snapshotKeyboardAgentRequest(jobId: string): KeyboardAgentJob | null {
  const existingJob = readKeyboardAgentJob(jobId);
  if (existingJob !== null) return existingJob;

  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_AGENT_REQUEST);
  if (raw === null) return null;

  let request: KeyboardAgentRequest;
  try {
    request = JSON.parse(raw) as KeyboardAgentRequest;
  } catch {
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_REQUEST);
    return null;
  }

  if (!request.requestedAtMs || Date.now() - request.requestedAtMs > FRESH_REQUEST_TTL_MS) {
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_REQUEST);
    return null;
  }

  // Consume the request immediately — before writing the job — so a concurrent
  // caller on a separate event-queue tick cannot consume the same request twice.
  AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_REQUEST);

  // follow_up without a sessionId falls back to compose: a fresh session has no
  // prior turns to revise, and keeping kind:'follow_up' would cause session_expired.
  const hasSession = request.kind === 'follow_up' && !!request.sessionId;
  const sessionId = hasSession ? (request.sessionId as string) : randomUUID();
  const kind: KeyboardAgentJob['kind'] =
    request.kind === 'follow_up' && !hasSession ? 'compose' : request.kind;

  const tone = useConfigStore.getState().config?.keyboardTone ?? DEFAULT_KEYBOARD_TONE;

  const job: KeyboardAgentJob = {
    jobId,
    sessionId,
    kind,
    tone,
    requestedAtMs: request.requestedAtMs,
    ...(request.selectedText !== undefined && { selectedText: request.selectedText }),
    ...(request.contextBefore !== undefined && { contextBefore: request.contextBefore }),
    ...(request.contextAfter !== undefined && { contextAfter: request.contextAfter }),
  };

  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_JOB, JSON.stringify(job));

  return job;
}

// Reads, validates, and consumes the one-shot keyboard_agent_action (regenerate).
// Both the action key and its epoch-ms twin are cleared unconditionally so a
// corrupt or stale value can't block future actions or replay on next launch.
// Returns null on absence, invalid JSON, missing fields, or stale timestamp (>15s).
export function consumeKeyboardAgentAction(): KeyboardAgentAction | null {
  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_AGENT_ACTION);
  if (raw === null) return null;

  const clear = (): void => {
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_ACTION);
    AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_ACTION_AT_MS);
  };

  const atMsRaw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_AGENT_ACTION_AT_MS);
  const atMs = Number(atMsRaw);
  if (!Number.isFinite(atMs) || atMs <= 0 || Date.now() - atMs > FRESH_REQUEST_TTL_MS) {
    clear();
    return null;
  }

  let action: KeyboardAgentAction;
  try {
    action = JSON.parse(raw) as KeyboardAgentAction;
  } catch {
    clear();
    return null;
  }

  clear();

  if (action.type !== 'regenerate' || !action.sessionId || !action.requestId) {
    return null;
  }
  return action;
}

// True when the keyboard raised the shared cancel flag (the user tapped X on the
// "Writing" pill). Read without clearing — the recording-stopped path and the
// composer's pre-write checkpoint both observe the same request; the keyboard
// clears it after the recording stops. Lets a generation drop its result before
// writing it, so a cancelled compose/action never surfaces the review card.
export function isKeyboardAgentCancelled(): boolean {
  return AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_CANCEL_REQUESTED) === '1';
}

export function readKeyboardAgentJob(jobId: string): KeyboardAgentJob | null {
  const raw = AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_AGENT_JOB);
  if (raw === null) return null;

  let job: KeyboardAgentJob;
  try {
    job = JSON.parse(raw) as KeyboardAgentJob;
  } catch {
    return null;
  }

  return job.jobId === jobId ? job : null;
}

// Clears the per-job key. The result key is intentionally NOT cleared here —
// it must survive app death so the keyboard can insert/dismiss after a crash.
// The result key is cleared by the keyboard after insert/dismiss and by
// initializeSharedState on app launch.
export function clearKeyboardAgentJob(): void {
  AppGroupStorage.removeItem(APP_GROUP_KEYS.KEYBOARD_AGENT_JOB);
}

// Enforces the 5-version cap and trims oversized strings to stay within the
// keyboard extension's jetsam budget. Adjusts activeIndex after each trim.
export function writeKeyboardAgentResult(input: KeyboardAgentResultInput): void {
  const droppedByCap = Math.max(0, input.versions.length - MAX_VERSIONS);
  const versions = input.versions
    .slice(-MAX_VERSIONS)
    .map((v) => (v.length > MAX_VERSION_CHARS ? v.slice(0, MAX_VERSION_CHARS) : v));

  let activeIndex = Math.max(0, input.activeIndex - droppedByCap);

  const result: KeyboardAgentResult = {
    sessionId: input.sessionId,
    jobId: input.jobId,
    versions,
    activeIndex,
    updatedAtMs: Date.now(),
  };

  let payload = JSON.stringify(result);

  while (payload.length > MAX_PAYLOAD_CHARS && result.versions.length > 1) {
    result.versions = result.versions.slice(1);
    activeIndex = Math.max(0, activeIndex - 1);
    result.activeIndex = Math.min(activeIndex, result.versions.length - 1);
    payload = JSON.stringify(result);
  }

  result.activeIndex = Math.min(result.activeIndex, result.versions.length - 1);
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AGENT_RESULT, JSON.stringify(result));
}
