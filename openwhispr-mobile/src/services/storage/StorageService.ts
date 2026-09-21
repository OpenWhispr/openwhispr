import 'expo-sqlite/localStorage/install';
import * as SecureStore from 'expo-secure-store';
import { UserConfig, Transcript } from '../../types';
import { STORAGE_KEYS } from '../../config/constants';

/**
 * Serialized agent session (structural, so StorageService stays decoupled from
 * the composer service). Kept in sync with `PersistedAgentSession` in
 * AgentComposerService.
 */
export interface StoredAgentSession {
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

  static async getTranscripts(): Promise<Transcript[]> {
    const json = localStorage.getItem(STORAGE_KEYS.TRANSCRIPTS);
    return json ? JSON.parse(json) : [];
  }

  static async saveTranscripts(transcripts: Transcript[]): Promise<void> {
    localStorage.setItem(STORAGE_KEYS.TRANSCRIPTS, JSON.stringify(transcripts));
  }

  static async clearTranscripts(): Promise<void> {
    localStorage.removeItem(STORAGE_KEYS.TRANSCRIPTS);
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
    localStorage.clear();
    await SecureStorageService.clearAuthToken();
  }
}
