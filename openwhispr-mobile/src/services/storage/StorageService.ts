import type { InferenceSelection } from '@/lib/mobileProviders';
import 'expo-sqlite/localStorage/install';
import * as SecureStore from 'expo-secure-store';
import { UserConfig, Transcript } from '../../types';
import { STORAGE_KEYS } from '../../config/constants';
import { clearProviderCredentials } from '../providers/ProviderCredentials';
import { captureTranscriptScope } from '@/lib/transcriptScope';

const ACCOUNT_TRANSCRIPTS_KEY = 'android.transcripts-by-owner.v1';

function readAccountTranscripts(): Record<string, Transcript[]> {
  const raw = localStorage.getItem(ACCOUNT_TRANSCRIPTS_KEY);
  if (raw === null) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((rows) => !Array.isArray(rows))
  )
    throw new Error('Saved history could not be opened. Your history has been kept.');
  return value as Record<string, Transcript[]>;
}

/**
 * Serialized agent session (structural, so StorageService stays decoupled from
 * the composer service). Kept in sync with `PersistedAgentSession` in
 * AgentComposerService.
 */
export interface StoredAgentSession {
  inferenceRoute?: InferenceSelection;
  sessionId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  versions: string[];
  lastActivityAtMs: number;
  latestRequestId: string | null;
}

export class SecureStorageService {
  static async saveAuthToken(token: string): Promise<void> {
    await SecureStore.setItemAsync(STORAGE_KEYS.AUTH_TOKEN, token);
  }

  static async getAuthToken(): Promise<string | null> {
    return await SecureStore.getItemAsync(STORAGE_KEYS.AUTH_TOKEN);
  }

  static async clearAuthToken(): Promise<void> {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.AUTH_TOKEN);
  }
}

/**
 * Main storage service for app data
 */
export class StorageService {
  static async getConfig(): Promise<UserConfig | null> {
    const json = localStorage.getItem(STORAGE_KEYS.USER_CONFIG);
    if (!json) {
      return null;
    }

    const parsed = JSON.parse(json) as Partial<UserConfig>;
    return {
      ...parsed,
      defaultMode: parsed.defaultMode || 'cloud',
    };
  }

  static async saveConfig(config: UserConfig): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.USER_CONFIG, JSON.stringify(config));
  }

  static async clearConfig(): Promise<void> {
    localStorage.removeItem(STORAGE_KEYS.USER_CONFIG);
  }

  static transcriptOwner(): string | null {
    return captureTranscriptScope()?.key ?? null;
  }

  static async getTranscripts(owner = StorageService.transcriptOwner()): Promise<Transcript[]> {
    if (owner !== null) return readAccountTranscripts()[owner] ?? [];
    const json = localStorage.getItem(STORAGE_KEYS.TRANSCRIPTS);
    return json ? JSON.parse(json) : [];
  }

  static async saveTranscripts(
    transcripts: Transcript[],
    owner = StorageService.transcriptOwner(),
  ): Promise<void> {
    if (owner !== null) {
      localStorage.setItem(
        ACCOUNT_TRANSCRIPTS_KEY,
        JSON.stringify({ ...readAccountTranscripts(), [owner]: transcripts }),
      );
      return;
    }
    localStorage.setItem(STORAGE_KEYS.TRANSCRIPTS, JSON.stringify(transcripts));
  }

  static async clearTranscripts(owner = StorageService.transcriptOwner()): Promise<void> {
    if (owner !== null) return StorageService.saveTranscripts([], owner);
    localStorage.removeItem(STORAGE_KEYS.TRANSCRIPTS);
  }

  static getAllTranscriptAudio(): string[] {
    // Include unassigned pre-upgrade rows: another account's load must not collect their audio.
    const rows = [
      ...Object.values(readAccountTranscripts()).flat(),
      ...JSON.parse(localStorage.getItem(STORAGE_KEYS.TRANSCRIPTS) ?? '[]'),
    ];
    return rows.flatMap((row) => (row.audioUrl ? [row.audioUrl] : []));
  }

  static async getUnassignedTranscripts(): Promise<Transcript[]> {
    const scope = captureTranscriptScope();
    if (scope?.owner !== 'local') throw new Error('Sign out to view older device history.');
    return StorageService.getTranscripts(null);
  }

  static async eraseTranscriptOwner(owner: string): Promise<void> {
    const { deleteManagedTranscriptAudio } =
      require('@/lib/transcriptAudio') as typeof import('@/lib/transcriptAudio');
    const { listPendingProviderRecoveryJobs, clearKeyboardProviderRecovery } =
      require('@/lib/keyboardInferenceRoute') as typeof import('@/lib/keyboardInferenceRoute');
    const byOwner = readAccountTranscripts();
    const jobs = listPendingProviderRecoveryJobs();
    const protectedAudio = new Set([
      ...Object.entries(byOwner)
        .filter(([key]) => key !== owner)
        .flatMap(([, rows]) => rows.map((row) => row.audioUrl)),
      ...(await StorageService.getTranscripts(null)).map((row) => row.audioUrl),
      ...jobs.filter((job) => job.historyOwner !== owner).map((job) => job.audioUri),
    ]);
    const ownedJobs = jobs.filter((job) => job.historyOwner === owner);
    const audio = [
      ...(byOwner[owner] ?? []).map((row) => row.audioUrl),
      ...ownedJobs.map((job) => job.audioUri),
    ];
    // Keep references until deletion succeeds so a failed erase can be retried.
    for (const uri of new Set(audio))
      if (uri && !protectedAudio.has(uri)) await deleteManagedTranscriptAudio(uri);
    for (const job of ownedJobs) clearKeyboardProviderRecovery(job.jobId);
    await StorageService.clearTranscripts(owner);
  }

  // Agent sessions persist so keyboard regenerate survives an app kill. The
  // payload is small (few sessions, capped versions), so a single synchronous
  // localStorage blob is enough — no need for a relational table.
  static saveAgentSessions(sessions: StoredAgentSession[]): void {
    try {
      localStorage.setItem(STORAGE_KEYS.AGENT_SESSIONS, JSON.stringify(sessions));
    } catch {
      // Persistence failure must not affect protocol behavior (result written +
      // agent_ready still happen).
      console.warn('[StorageService] Failed to persist agent sessions');
    }
  }

  static loadAgentSessions(): StoredAgentSession[] | null {
    const json = localStorage.getItem(STORAGE_KEYS.AGENT_SESSIONS);
    if (!json) return null;
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredAgentSession[]) : null;
    } catch {
      return null;
    }
  }

  static clearAgentSessions(): void {
    localStorage.removeItem(STORAGE_KEYS.AGENT_SESSIONS);
  }

  static async clearAll(): Promise<void> {
    await clearProviderCredentials();
    localStorage.clear();
    await SecureStorageService.clearAuthToken();
  }
}
