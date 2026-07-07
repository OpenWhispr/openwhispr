import type {
  NoteItem,
  FolderItem,
  TranscriptionItem,
  ConversationPreview,
} from "../types/electron";
import { NotesService } from "./NotesService.js";
import { ConversationsService } from "./ConversationsService.js";
import { FoldersService } from "./FoldersService.js";
import { TranscriptionsService } from "./TranscriptionsService.js";
import { DictionaryService } from "./DictionaryService.js";
import { SnippetService, type CloudSnippetEntry } from "./SnippetService.js";
import { CloudApiError } from "./cloudApi.js";

function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof CloudApiError && err.status === status;
}

const PUSH_DEBOUNCE_MS = 2000;
const BATCH_SIZE = 50;
const TRANSCRIPTION_BATCH_SIZE = 100;
const DICTIONARY_BATCH_SIZE = 200;
const SNIPPET_BATCH_SIZE = 200;
// Minimum gap between auto syncs, measured from the last completed pass in
// any window (the stamp lives in shared localStorage).
const AUTO_SYNC_THROTTLE_MS = 20000;
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// Web Lock name serializing syncAll() across windows (each renderer has its
// own SyncService instance, but localStorage and the local DB are shared).
const SYNC_ALL_LOCK = "openwhispr-sync-all";
// localStorage keys gating canSync(); a change in another window means sync
// may have just become possible (sign-in, subscription, backup enabled).
const CAN_SYNC_KEYS = ["isSignedIn", "cloudBackupEnabled", "isSubscribed"];

// SQLite `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" (no T, no millis, no Z);
// the cloud sends ISO 8601 "YYYY-MM-DDTHH:MM:SS.sssZ". Normalize both to
// millis-precision ISO so the pull loop's lexical greater-than compares
// correctly — without the ".000" pad a whole-second local value sorts after a
// sub-second cloud value at the same instant ('Z' > '.').
function normalizeTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const iso = value.replace(" ", "T").replace(/Z$/, "");
  return (/\.\d+$/.test(iso) ? iso : `${iso}.000`) + "Z";
}

class SyncService {
  private syncing = false;
  private syncAllPending = false;
  private autoSyncStarted = false;
  private dictionaryDirty = false;
  private snippetsDirty = false;
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  canSync(): boolean {
    return (
      localStorage.getItem("isSignedIn") === "true" &&
      localStorage.getItem("cloudBackupEnabled") === "true" &&
      localStorage.getItem("isSubscribed") === "true"
    );
  }

  // lastSyncedAt is written only when a syncAll() pass completes, and
  // localStorage is shared across windows, so it doubles as the global
  // "last completed sync" stamp for throttling.
  private lastCompletedSyncAt(): number {
    const iso = localStorage.getItem("lastSyncedAt");
    return iso ? Date.parse(iso) : 0;
  }

  // Runs in every window for the whole session; the throttle and Web Lock
  // dedupe across windows.
  startAutoSync(): void {
    if (this.autoSyncStarted) return;
    this.autoSyncStarted = true;

    this.requestSyncAll("start");
    window.addEventListener("focus", () => this.requestSyncAll("focus"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.requestSyncAll("focus");
      }
    });
    window.addEventListener("online", () => this.requestSyncAll("online"));
    // storage events fire only in the windows that didn't write the change,
    // which is exactly where a first sync is still needed.
    window.addEventListener("storage", (e) => {
      if (e.key && CAN_SYNC_KEYS.includes(e.key)) {
        this.requestSyncAll("start");
      }
    });
    setInterval(() => this.requestSyncAll("interval"), AUTO_SYNC_INTERVAL_MS);
  }

  async syncAll(waitForLock = false): Promise<void> {
    if (!this.canSync()) return;
    // A pass already running may have synced past the data this request covers,
    // so flag a re-run instead of dropping it.
    if (this.syncing) {
      this.syncAllPending = true;
      return;
    }
    this.syncing = true;
    try {
      // Ambient passes skip when another window holds the lock — that pass
      // reads the same local DB and cloud state, so it covers this request.
      // Manual passes wait so a user action is never silently dropped.
      await navigator.locks.request(SYNC_ALL_LOCK, { ifAvailable: !waitForLock }, async (lock) => {
        if (!lock) return;
        await this.syncFolders();
        await this.syncNotes();
        await this.syncConversations();
        await this.syncTranscriptions();
        // Edits during the awaits above set dictionaryDirty (syncing is already
        // true), so re-run until clean rather than stalling until the next trigger.
        do {
          this.dictionaryDirty = false;
          await this.syncDictionary();
        } while (this.dictionaryDirty);
        do {
          this.snippetsDirty = false;
          await this.syncSnippets();
        } while (this.snippetsDirty);
        localStorage.setItem("lastSyncedAt", new Date().toISOString());
      });
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      this.syncing = false;
    }
    if (this.syncAllPending) {
      this.syncAllPending = false;
      await this.syncAll();
    }
  }

  requestSyncAll(reason: "start" | "focus" | "interval" | "online" | "manual"): void {
    if (!this.canSync()) return;
    if (
      reason !== "manual" &&
      (this.syncing || Date.now() - this.lastCompletedSyncAt() < AUTO_SYNC_THROTTLE_MS)
    ) {
      return;
    }
    void this.syncAll(reason === "manual");
  }

  async syncDictionaryNow(): Promise<void> {
    if (!this.canSync()) return;
    // A sync already running will drain dictionaryDirty before it finishes, so
    // flag a re-run instead of dropping this request.
    if (this.syncing) {
      this.dictionaryDirty = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.dictionaryDirty = false;
        await this.syncDictionary();
      } while (this.dictionaryDirty);
    } catch (err) {
      console.error("Dictionary sync failed:", err);
    } finally {
      this.syncing = false;
    }
  }

  async syncSnippetsNow(): Promise<void> {
    if (!this.canSync()) return;
    if (this.syncing) {
      this.snippetsDirty = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.snippetsDirty = false;
        await this.syncSnippets();
      } while (this.snippetsDirty);
    } catch (err) {
      console.error("Snippets sync failed:", err);
    } finally {
      this.syncing = false;
    }
  }

  debouncedPush(entityType: string, entityId: number): void {
    if (!this.canSync()) return;
    const key = `${entityType}:${entityId}`;
    const existing = this.pushTimers.get(key);
    if (existing) clearTimeout(existing);
    this.pushTimers.set(
      key,
      setTimeout(() => {
        this.pushTimers.delete(key);
        this.pushEntity(entityType, entityId).catch(console.error);
      }, PUSH_DEBOUNCE_MS)
    );
  }

  private async pushEntity(entityType: string, entityId: number): Promise<void> {
    if (!this.canSync()) return;
    switch (entityType) {
      case "folder":
        return this.pushFolder(entityId);
      case "note":
        return this.pushNote(entityId);
      case "conversation":
        return this.pushConversation(entityId);
      case "transcription":
        return this.pushTranscription(entityId);
    }
  }

  private async pushFolder(id: number): Promise<void> {
    const folders = (await window.electronAPI.getFolders?.()) ?? [];
    const folder = folders.find((f) => f.id === id);
    if (!folder) return;

    if (folder.cloud_id) {
      await FoldersService.update(folder.cloud_id, {
        name: folder.name,
        sort_order: folder.sort_order,
      });
    } else {
      const cloud = await FoldersService.create({
        name: folder.name,
        client_folder_id: folder.client_folder_id,
        is_default: !!folder.is_default,
        sort_order: folder.sort_order,
      });
      await window.electronAPI.markFolderSynced?.(folder.id, cloud.id);
    }
  }

  private async pushNote(id: number): Promise<void> {
    const note = await window.electronAPI.getNote?.(id);
    if (!note) return;

    const folderMap = await this.buildLocalToCloudFolderMap();
    const cloudFolderId = note.folder_id ? (folderMap.get(note.folder_id) ?? null) : null;

    if (note.cloud_id) {
      await NotesService.update(note.cloud_id, {
        title: note.title,
        content: note.content,
        enhanced_content: note.enhanced_content,
        enhancement_prompt: note.enhancement_prompt,
        enhanced_at_content_hash: note.enhanced_at_content_hash,
        note_type: note.note_type,
        source_file: note.source_file,
        audio_duration_seconds: note.audio_duration_seconds,
        transcript: note.transcript,
        participants: note.participants,
        calendar_event_id: note.calendar_event_id,
        diarization_enabled: note.diarization_enabled,
        expected_speaker_count: note.expected_speaker_count,
        folder_id: cloudFolderId,
        updated_at: note.updated_at,
      });
    } else {
      const cloud = await NotesService.create({
        client_note_id: note.client_note_id,
        title: note.title,
        content: note.content,
        enhanced_content: note.enhanced_content,
        enhancement_prompt: note.enhancement_prompt,
        enhanced_at_content_hash: note.enhanced_at_content_hash,
        note_type: note.note_type,
        source_file: note.source_file,
        audio_duration_seconds: note.audio_duration_seconds,
        transcript: note.transcript,
        participants: note.participants,
        calendar_event_id: note.calendar_event_id,
        diarization_enabled: note.diarization_enabled,
        expected_speaker_count: note.expected_speaker_count,
        folder_id: cloudFolderId,
        created_at: note.created_at,
        updated_at: note.updated_at,
      });
      await window.electronAPI.markNoteSynced?.(note.id, cloud.id);
    }
  }

  private async pushConversation(id: number): Promise<void> {
    const full = await window.electronAPI.getAgentConversation?.(id);
    if (!full) return;

    if (full.cloud_id) {
      await ConversationsService.update(full.cloud_id, { title: full.title });
    } else {
      const cloud = await ConversationsService.create({
        client_conversation_id: String(full.id),
        title: full.title,
        created_at: full.created_at,
        updated_at: full.updated_at,
        messages: full.messages.map((m) => ({
          role: m.role,
          content: m.content,
          metadata: m.metadata
            ? typeof m.metadata === "string"
              ? JSON.parse(m.metadata)
              : m.metadata
            : null,
        })),
      });
      await window.electronAPI.markConversationSynced?.(full.id, cloud.id);
    }
  }

  private async pushTranscription(id: number): Promise<void> {
    const t = await window.electronAPI.getTranscriptionById?.(id);
    if (!t || t.cloud_id) return;

    const cloud = await TranscriptionsService.create({
      client_transcription_id: t.client_transcription_id,
      text: t.text,
      raw_text: t.raw_text,
      provider: t.provider,
      model: t.model,
      audio_duration_ms: t.audio_duration_ms,
      status: t.status,
      created_at: t.created_at,
    });
    await window.electronAPI.markTranscriptionSynced?.(t.id, cloud.id);
  }

  private async syncFolders(): Promise<void> {
    await this.pushPendingFolders();
    await this.pushFolderDeletes();
    await this.pullFolders();
  }

  private async pushFolderDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingFolderDeletes?.()) ?? [];
    for (const f of deletes) {
      if (!f.cloud_id) continue;
      try {
        await FoldersService.delete(f.cloud_id);
        await window.electronAPI.hardDeleteFolder?.(f.id);
      } catch (err) {
        console.error("Folder delete sync failed:", err);
      }
    }
  }

  private async pushPendingFolders(): Promise<void> {
    const pending = (await window.electronAPI.getPendingFolders?.()) ?? [];
    if (pending.length === 0) return;

    const migration = pending.filter((f) => f.cloud_id);
    const fresh = pending.filter((f) => !f.cloud_id);

    for (const folder of migration) {
      try {
        await FoldersService.update(folder.cloud_id!, { name: folder.name });
        await window.electronAPI.markFolderSynced?.(folder.id, folder.cloud_id!);
      } catch (err) {
        console.error("Folder migration sync failed:", err);
      }
    }

    if (fresh.length > 0) {
      try {
        const { created } = await FoldersService.batchCreate(
          fresh.map((f) => ({
            name: f.name,
            client_folder_id: f.client_folder_id,
            is_default: !!f.is_default,
            sort_order: f.sort_order,
          }))
        );
        for (const cloudFolder of created) {
          const local = fresh.find((f) => f.client_folder_id === cloudFolder.client_folder_id);
          if (local) await window.electronAPI.markFolderSynced?.(local.id, cloudFolder.id);
        }
      } catch (err) {
        console.error("Folder batch create failed:", err);
      }
    }
  }

  private async pullFolders(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.folders") ?? undefined;
      const syncStartedAt = new Date().toISOString();
      const { folders: cloudFolders } = await FoldersService.list(since);

      for (const cloudFolder of cloudFolders) {
        const local = await window.electronAPI.getFolderByClientId?.(
          cloudFolder.client_folder_id ?? ""
        );

        if (cloudFolder.deleted_at) {
          if (local) await window.electronAPI.hardDeleteFolder?.(local.id);
          continue;
        }

        if (local?.deleted_at) continue;
        if (!local || cloudFolder.updated_at > local.updated_at) {
          await window.electronAPI.upsertFolderFromCloud?.(
            cloudFolder as unknown as Record<string, unknown>
          );
        }
      }

      localStorage.setItem("lastSyncedAt.folders", syncStartedAt);
    } catch (err) {
      console.error("Folder pull failed:", err);
    }
  }

  private async syncNotes(): Promise<void> {
    await this.pushPendingNotes();
    await this.pushNoteDeletes();
    await this.pullNotes();
  }

  private async pushPendingNotes(): Promise<void> {
    const pending = (await window.electronAPI.getPendingNotes?.()) ?? [];
    if (pending.length === 0) return;

    const folderMap = await this.buildLocalToCloudFolderMap();
    const migration = pending.filter((n) => n.cloud_id);
    const fresh = pending.filter((n) => !n.cloud_id);

    for (const note of migration) {
      try {
        await NotesService.update(note.cloud_id!, { client_note_id: note.client_note_id });
        await window.electronAPI.markNoteSynced?.(note.id, note.cloud_id!);
      } catch {
        await window.electronAPI.markNoteSyncError?.(note.id);
      }
    }

    for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
      const chunk = fresh.slice(i, i + BATCH_SIZE);
      try {
        const { created } = await NotesService.batchCreate(
          chunk.map((n) => ({
            client_note_id: n.client_note_id,
            title: n.title,
            content: n.content,
            enhanced_content: n.enhanced_content,
            enhancement_prompt: n.enhancement_prompt,
            enhanced_at_content_hash: n.enhanced_at_content_hash,
            note_type: n.note_type,
            source_file: n.source_file,
            audio_duration_seconds: n.audio_duration_seconds,
            transcript: n.transcript,
            folder_id: n.folder_id ? (folderMap.get(n.folder_id) ?? undefined) : undefined,
            created_at: n.created_at,
            updated_at: n.updated_at,
          }))
        );
        for (const { client_note_id, id: cloudId } of created) {
          const local = chunk.find((n) => n.client_note_id === client_note_id);
          if (local) await window.electronAPI.markNoteSynced?.(local.id, cloudId);
        }
      } catch {
        for (const n of chunk) {
          await window.electronAPI.markNoteSyncError?.(n.id);
        }
      }
    }
  }

  private async pushNoteDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingNoteDeletes?.()) ?? [];
    for (const note of deletes) {
      try {
        await NotesService.delete(note.cloud_id!);
        await window.electronAPI.hardDeleteNote?.(note.id);
      } catch (err) {
        console.error("Note delete sync failed:", err);
      }
    }
  }

  private async pullNotes(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.notes") ?? undefined;
      const syncStartedAt = new Date().toISOString();
      const { cloudToLocal, defaultFolderId } = await this.buildCloudToLocalFolderMap();

      let cursor: string | undefined = since;
      while (true) {
        const { notes: cloudNotes } = since
          ? await NotesService.list(BATCH_SIZE, undefined, cursor)
          : await NotesService.list(BATCH_SIZE, cursor);
        if (cloudNotes.length === 0) break;

        for (const cloudNote of cloudNotes) {
          const local = await window.electronAPI.getNoteByClientId?.(
            cloudNote.client_note_id ?? ""
          );

          if (cloudNote.deleted_at) {
            if (local) await window.electronAPI.hardDeleteNote?.(local.id);
            continue;
          }

          if (!local || cloudNote.updated_at > local.updated_at) {
            const localFolderId = cloudNote.folder_id
              ? (cloudToLocal.get(cloudNote.folder_id) ?? defaultFolderId)
              : defaultFolderId;
            await window.electronAPI.upsertNoteFromCloud?.(
              cloudNote as unknown as Record<string, unknown>,
              localFolderId
            );
          }
        }

        if (cloudNotes.length < BATCH_SIZE) break;
        const last = cloudNotes[cloudNotes.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      localStorage.setItem("lastSyncedAt.notes", syncStartedAt);
    } catch (err) {
      console.error("Note pull failed:", err);
    }
  }

  private async syncConversations(): Promise<void> {
    await this.pushPendingConversations();
    await this.pushConversationDeletes();
    await this.pullConversations();
  }

  private async pushPendingConversations(): Promise<void> {
    const pending = (await window.electronAPI.getPendingConversations?.()) ?? [];
    if (pending.length === 0) return;

    const migration = pending.filter((c) => c.cloud_id);
    const fresh = pending.filter((c) => !c.cloud_id);

    for (const conv of migration) {
      try {
        await ConversationsService.update(conv.cloud_id!, { title: conv.title });
        await window.electronAPI.markConversationSynced?.(conv.id, conv.cloud_id!);
      } catch (err) {
        console.error("Conversation migration sync failed:", err);
      }
    }

    for (const conv of fresh) {
      try {
        const full = await window.electronAPI.getAgentConversation?.(conv.id);
        if (!full) continue;
        const cloudConv = await ConversationsService.create({
          client_conversation_id: conv.client_conversation_id ?? String(conv.id),
          title: conv.title,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          messages: full.messages.map((m) => ({
            role: m.role,
            content: m.content,
            metadata: m.metadata
              ? typeof m.metadata === "string"
                ? JSON.parse(m.metadata)
                : m.metadata
              : null,
          })),
        });
        await window.electronAPI.markConversationSynced?.(conv.id, cloudConv.id);
      } catch (err) {
        console.error("Conversation sync failed:", err);
      }
    }
  }

  private async pushConversationDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingConversationDeletes?.()) ?? [];
    for (const conv of deletes) {
      try {
        await ConversationsService.delete(conv.cloud_id!);
        await window.electronAPI.hardDeleteConversation?.(conv.id);
      } catch (err) {
        console.error("Conversation delete sync failed:", err);
      }
    }
  }

  private async pullConversations(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.conversations") ?? undefined;
      const syncStartedAt = new Date().toISOString();

      let cursor: string | undefined = since;
      while (true) {
        const { conversations: cloudConvs } = since
          ? await ConversationsService.list(BATCH_SIZE, undefined, false, "messages", cursor)
          : await ConversationsService.list(BATCH_SIZE, cursor, false, "messages");
        if (cloudConvs.length === 0) break;

        for (const cloudConv of cloudConvs) {
          const local = await window.electronAPI.getConversationByClientId?.(
            cloudConv.client_conversation_id ?? ""
          );

          if (cloudConv.deleted_at) {
            if (local) await window.electronAPI.hardDeleteConversation?.(local.id);
            continue;
          }

          if (!local || cloudConv.updated_at > local.updated_at) {
            await window.electronAPI.upsertConversationFromCloud?.(
              cloudConv as unknown as Record<string, unknown>,
              (cloudConv.messages ?? []) as unknown as Array<Record<string, unknown>>
            );
          }
        }

        if (cloudConvs.length < BATCH_SIZE) break;
        const last = cloudConvs[cloudConvs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      localStorage.setItem("lastSyncedAt.conversations", syncStartedAt);
    } catch (err) {
      console.error("Conversation pull failed:", err);
    }
  }

  private async syncTranscriptions(): Promise<void> {
    await this.pushPendingTranscriptions();
    await this.pushTranscriptionDeletes();
    await this.pullTranscriptions();
  }

  private async pushTranscriptionDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingTranscriptionDeletes?.()) ?? [];
    const withCloudId = deletes.filter((t) => t.cloud_id);
    if (withCloudId.length === 0) return;

    for (let i = 0; i < withCloudId.length; i += TRANSCRIPTION_BATCH_SIZE) {
      const chunk = withCloudId.slice(i, i + TRANSCRIPTION_BATCH_SIZE);
      try {
        const { deleted } = await TranscriptionsService.batchDelete(chunk.map((t) => t.cloud_id!));
        for (const cloudId of deleted) {
          const local = chunk.find((t) => t.cloud_id === cloudId);
          if (local) await window.electronAPI.hardDeleteTranscription?.(local.id);
        }
      } catch (err) {
        console.error("Transcription batch delete failed:", err);
      }
    }
  }

  private async pushPendingTranscriptions(): Promise<void> {
    const pending = ((await window.electronAPI.getPendingTranscriptions?.()) ?? []).filter(
      (t) => !!t.text?.trim()
    );
    if (pending.length === 0) return;

    for (let i = 0; i < pending.length; i += TRANSCRIPTION_BATCH_SIZE) {
      const chunk = pending.slice(i, i + TRANSCRIPTION_BATCH_SIZE);
      try {
        const { created } = await TranscriptionsService.batchCreate(
          chunk.map((t) => ({
            client_transcription_id: t.client_transcription_id,
            text: t.text,
            raw_text: t.raw_text,
            provider: t.provider,
            model: t.model,
            audio_duration_ms: t.audio_duration_ms,
            status: t.status,
            created_at: t.created_at,
          }))
        );
        for (const cloudT of created) {
          const local = chunk.find(
            (t) => t.client_transcription_id === cloudT.client_transcription_id
          );
          if (local) await window.electronAPI.markTranscriptionSynced?.(local.id, cloudT.id);
        }
      } catch (err) {
        console.error("Transcription batch create failed:", err);
      }
    }
  }

  private async pullTranscriptions(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.transcriptions") ?? undefined;
      const syncStartedAt = new Date().toISOString();

      let cursor: string | undefined = since;
      while (true) {
        const { transcriptions: cloudTs } = since
          ? await TranscriptionsService.list(TRANSCRIPTION_BATCH_SIZE, undefined, cursor)
          : await TranscriptionsService.list(TRANSCRIPTION_BATCH_SIZE, cursor);
        if (cloudTs.length === 0) break;

        for (const cloudT of cloudTs) {
          const local = await window.electronAPI.getTranscriptionByClientId?.(
            cloudT.client_transcription_id ?? ""
          );

          if (cloudT.deleted_at) {
            if (local) await window.electronAPI.hardDeleteTranscription?.(local.id);
            continue;
          }

          if (!cloudT.text) continue;

          if (!local) {
            await window.electronAPI.upsertTranscriptionFromCloud?.(
              cloudT as unknown as Record<string, unknown>
            );
          }
        }

        if (cloudTs.length < TRANSCRIPTION_BATCH_SIZE) break;
        const last = cloudTs[cloudTs.length - 1];
        const next = since ? last.updated_at : last.created_at;
        if (next === cursor) break;
        cursor = next;
      }

      localStorage.setItem("lastSyncedAt.transcriptions", syncStartedAt);
    } catch (err) {
      console.error("Transcription pull failed:", err);
    }
  }

  private async syncDictionary(): Promise<void> {
    // Fail loud on preload skew: a missing binding silently optional-chained to
    // a no-op would lose user data, so assert the whole surface up front.
    const api = window.electronAPI;
    const required = [
      "getPendingDictionary",
      "getPendingDictionaryDeletes",
      "getDictionaryByClientId",
      "upsertDictionaryFromCloud",
      "markDictionarySynced",
      "hardDeleteDictionary",
      "clearDictionaryCloudId",
      "broadcastDictionaryUpdated",
    ] as const;
    const missing = required.filter((name) => typeof api[name] !== "function");
    if (missing.length > 0) {
      throw new Error(
        `Dictionary IPC bindings missing — preload out of date: ${missing.join(", ")}`
      );
    }

    await this.pushPendingDictionary();
    await this.pushDictionaryDeletes();
    await this.pullDictionary();
  }

  private async pushPendingDictionary(): Promise<void> {
    const pending = (await window.electronAPI.getPendingDictionary?.()) ?? [];
    if (pending.length === 0) return;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    for (const entry of updates) {
      try {
        await DictionaryService.update(entry.cloud_id!, {
          word: entry.word,
          source: entry.source,
        });
        await window.electronAPI.markDictionarySynced?.(entry.id, entry.cloud_id!);
      } catch (err) {
        // 404: another device purged the cloud row. Clear the stale cloud_id so
        // the next push re-creates it via batchCreate instead of retrying PATCH.
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.clearDictionaryCloudId?.(entry.id);
        } else {
          console.error("Dictionary update sync failed:", err);
        }
      }
    }

    for (let i = 0; i < creates.length; i += DICTIONARY_BATCH_SIZE) {
      const chunk = creates.slice(i, i + DICTIONARY_BATCH_SIZE);
      try {
        const { created } = await DictionaryService.batchCreate(
          chunk.map((e) => ({
            client_dict_id: e.client_dict_id,
            word: e.word,
            source: e.source,
            created_at: e.created_at,
            updated_at: e.updated_at,
          }))
        );
        const byClientId = new Map(created.map((c) => [c.client_dict_id, c]));
        let unmatched = 0;
        for (const local of chunk) {
          const server = byClientId.get(local.client_dict_id);
          if (!server) {
            unmatched += 1;
            continue;
          }
          // 0 changes means the local row was deleted between snapshot and ack —
          // delete the freshly-created server row so we don't orphan it.
          const result = await window.electronAPI.markDictionarySynced?.(local.id, server.id);
          if (result && result.changes === 0) {
            try {
              await DictionaryService.delete(server.id);
            } catch (deleteErr) {
              console.error("Dictionary orphan cleanup failed:", deleteErr);
            }
          }
        }
        if (unmatched > 0) {
          console.warn(
            `Dictionary batch-create: ${unmatched}/${chunk.length} rows had no matching server response`
          );
        }
      } catch (err) {
        console.error("Dictionary batch create failed:", err);
      }
    }
  }

  private async pushDictionaryDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingDictionaryDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id) continue;
      try {
        await DictionaryService.delete(entry.cloud_id);
        await window.electronAPI.hardDeleteDictionary?.(entry.id);
      } catch (err) {
        // 404 means the row is already gone server-side — treat as success.
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.hardDeleteDictionary?.(entry.id);
        } else {
          console.error("Dictionary delete sync failed:", err);
        }
      }
    }
  }

  private async pullDictionary(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.dictionary") ?? undefined;
      const sinceId = localStorage.getItem("lastSyncedAt.dictionary.id") ?? undefined;
      let changed = false;

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";

      while (true) {
        const { entries, hasMore } = await DictionaryService.list(
          cursor,
          DICTIONARY_BATCH_SIZE,
          cursorId
        );
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const local = await window.electronAPI.getDictionaryByClientId?.(
            cloudEntry.client_dict_id ?? ""
          );

          if (cloudEntry.deleted_at) {
            if (local) {
              await window.electronAPI.hardDeleteDictionary?.(local.id);
              changed = true;
            }
            continue;
          }

          // Last-writer-wins on normalized timestamps (see normalizeTimestamp).
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const localTs = local ? normalizeTimestamp(local.updated_at) : "";
          if (!local || cloudTs > localTs) {
            await window.electronAPI.upsertDictionaryFromCloud?.(
              cloudEntry as unknown as Record<string, unknown>
            );
            changed = true;
          }

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }
        }

        if (!hasMore) break;
        const last = entries[entries.length - 1];
        // Stall guard: if the (updated_at, id) cursor didn't advance after a
        // full page, bail rather than loop forever.
        if (last.updated_at === cursor && last.id === cursorId) break;
        cursor = last.updated_at;
        cursorId = last.id;
      }

      if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.dictionary", maxUpdatedAt);
      if (maxId) localStorage.setItem("lastSyncedAt.dictionary.id", maxId);
      if (changed) await window.electronAPI.broadcastDictionaryUpdated?.();
    } catch (err) {
      console.error("Dictionary pull failed:", err);
    }
  }

  private async syncSnippets(): Promise<void> {
    const api = window.electronAPI;
    const required = [
      "getPendingSnippets",
      "getPendingSnippetDeletes",
      "getSnippetForCloudMerge",
      "upsertSnippetFromCloud",
      "markSnippetSynced",
      "hardDeleteSnippet",
      "clearSnippetCloudId",
      "broadcastSnippetsUpdated",
    ] as const;
    const missing = required.filter((name) => typeof api[name] !== "function");
    if (missing.length > 0) {
      throw new Error(`Snippet IPC bindings missing — preload out of date: ${missing.join(", ")}`);
    }

    await this.pushPendingSnippets();
    await this.pushSnippetDeletes();
    await this.pullSnippets();
  }

  private async pushPendingSnippets(): Promise<void> {
    const pending = (await window.electronAPI.getPendingSnippets?.()) ?? [];
    if (pending.length === 0) return;

    const updates = pending.filter((e) => e.cloud_id);
    const creates = pending.filter((e) => !e.cloud_id);

    for (const entry of updates) {
      try {
        const server = await SnippetService.update(entry.cloud_id!, {
          trigger: entry.trigger,
          replacement: entry.replacement,
        });
        await window.electronAPI.markSnippetSynced?.(
          entry.id,
          server.id,
          server.updated_at,
          entry.trigger,
          entry.replacement
        );
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          // Cloud row purged elsewhere — drop the stale cloud_id so the next push
          // re-creates it via batchCreate.
          await window.electronAPI.clearSnippetCloudId?.(entry.id);
        } else if (isHttpStatus(err, 409)) {
          // Another snippet already holds this trigger, so the server keeps
          // rejecting the rename. Mark synced to stop re-pushing the doomed PATCH.
          await window.electronAPI.markSnippetSynced?.(
            entry.id,
            entry.cloud_id!,
            undefined,
            entry.trigger,
            entry.replacement
          );
        } else {
          console.error("Snippet update sync failed:", err);
        }
      }
    }

    for (let i = 0; i < creates.length; i += SNIPPET_BATCH_SIZE) {
      const chunk = creates.slice(i, i + SNIPPET_BATCH_SIZE);
      try {
        const { created } = await SnippetService.batchCreate(
          chunk.map((e) => ({
            client_snippet_id: e.client_snippet_id,
            trigger: e.trigger,
            replacement: e.replacement,
            created_at: e.created_at,
            updated_at: e.updated_at,
          }))
        );
        const byClientId = new Map(created.map((c) => [c.client_snippet_id, c]));
        let unmatched = 0;
        for (const local of chunk) {
          const server = byClientId.get(local.client_snippet_id);
          if (!server) {
            unmatched += 1;
            continue;
          }
          const result = await window.electronAPI.markSnippetSynced?.(
            local.id,
            server.id,
            server.updated_at,
            local.trigger,
            local.replacement
          );
          if (result && result.changes === 0) {
            try {
              await SnippetService.delete(server.id);
            } catch (deleteErr) {
              console.error("Snippet orphan cleanup failed:", deleteErr);
            }
          }
        }
        if (unmatched > 0) {
          console.warn(
            `Snippet batch-create: ${unmatched}/${chunk.length} rows had no matching server response`
          );
        }
      } catch (err) {
        console.error("Snippet batch create failed:", err);
      }
    }
  }

  private async pushSnippetDeletes(): Promise<void> {
    const deletes = (await window.electronAPI.getPendingSnippetDeletes?.()) ?? [];
    for (const entry of deletes) {
      if (!entry.cloud_id) continue;
      try {
        await SnippetService.delete(entry.cloud_id);
        await window.electronAPI.hardDeleteSnippet?.(entry.id);
      } catch (err) {
        if (isHttpStatus(err, 404)) {
          await window.electronAPI.hardDeleteSnippet?.(entry.id);
        } else {
          console.error("Snippet delete sync failed:", err);
        }
      }
    }
  }

  private async pullSnippets(): Promise<void> {
    try {
      const since = localStorage.getItem("lastSyncedAt.snippets") ?? undefined;
      const sinceId = localStorage.getItem("lastSyncedAt.snippets.id") ?? undefined;
      let changed = false;

      let cursor: string | undefined = since;
      let cursorId: string | undefined = sinceId;
      let maxUpdatedAt = normalizeTimestamp(since);
      let maxId = sinceId ?? "";
      const cursorField: keyof Pick<CloudSnippetEntry, "created_at" | "updated_at"> = since
        ? "updated_at"
        : "created_at";

      while (true) {
        const { entries, hasMore } = since
          ? await SnippetService.listDelta(cursor, SNIPPET_BATCH_SIZE, cursorId)
          : await SnippetService.listSnapshot(cursor, SNIPPET_BATCH_SIZE, cursorId);
        if (entries.length === 0) break;

        for (const cloudEntry of entries) {
          const cloudTs = normalizeTimestamp(cloudEntry.updated_at);
          const local = await window.electronAPI.getSnippetForCloudMerge?.(
            cloudEntry as unknown as Record<string, unknown>
          );

          if (cloudTs > maxUpdatedAt) {
            maxUpdatedAt = cloudTs;
            maxId = cloudEntry.id;
          } else if (cloudTs === maxUpdatedAt && cloudEntry.id > maxId) {
            maxId = cloudEntry.id;
          }

          if (cloudEntry.deleted_at) {
            if (local && !(local.sync_status === "pending" && !local.cloud_id)) {
              await window.electronAPI.hardDeleteSnippet?.(local.id);
              changed = true;
            }
            continue;
          }

          const localTs = local ? normalizeTimestamp(local.updated_at) : "";
          const shouldApply =
            !local ||
            cloudTs > localTs ||
            (local.sync_status !== "pending" &&
              (!local.cloud_id || local.cloud_id !== cloudEntry.id));
          if (shouldApply) {
            await window.electronAPI.upsertSnippetFromCloud?.(
              cloudEntry as unknown as Record<string, unknown>
            );
            changed = true;
          }
        }

        if (!hasMore) break;
        const last = entries[entries.length - 1];
        const nextCursor = last[cursorField];
        if (nextCursor === cursor && last.id === cursorId) break;
        cursor = nextCursor;
        cursorId = last.id;
      }

      if (maxUpdatedAt) localStorage.setItem("lastSyncedAt.snippets", maxUpdatedAt);
      if (maxId) localStorage.setItem("lastSyncedAt.snippets.id", maxId);
      if (changed) await window.electronAPI.broadcastSnippetsUpdated?.();
    } catch (err) {
      console.error("Snippet pull failed:", err);
    }
  }

  private async buildLocalToCloudFolderMap(): Promise<Map<number, string>> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    return new Map(folders.filter((f) => f.cloud_id).map((f) => [f.id, f.cloud_id!]));
  }

  private async buildCloudToLocalFolderMap(): Promise<{
    cloudToLocal: Map<string, number>;
    defaultFolderId: number | null;
  }> {
    const folders = (await window.electronAPI.getFolderIdMap?.()) ?? [];
    const cloudToLocal = new Map(folders.filter((f) => f.cloud_id).map((f) => [f.cloud_id!, f.id]));
    const personalFolder = folders.find((f) => f.is_default && f.name === "Personal");
    return { cloudToLocal, defaultFolderId: personalFolder?.id ?? null };
  }
}

export const syncService = new SyncService();
