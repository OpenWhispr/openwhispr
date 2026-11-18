import type { Transcript } from '../../types';
import { STORAGE_KEYS } from '../../config/constants';
import { captureTranscriptScope } from '@/lib/transcriptScope';

const upstream = require('./StorageService.ts') as typeof import('./StorageService');
export const { SecureStorageService } = upstream;
export type { StoredAgentSession } from './StorageService';

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

export class StorageService extends upstream.StorageService {
  static transcriptOwner(): string | null {
    return captureTranscriptScope()?.key ?? null;
  }

  static override async getTranscripts(
    owner = StorageService.transcriptOwner(),
  ): Promise<Transcript[]> {
    if (owner !== null) return readAccountTranscripts()[owner] ?? [];
    const json = localStorage.getItem(STORAGE_KEYS.TRANSCRIPTS);
    return json ? JSON.parse(json) : [];
  }

  static override async saveTranscripts(
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

  static override async clearTranscripts(owner = StorageService.transcriptOwner()): Promise<void> {
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
}
