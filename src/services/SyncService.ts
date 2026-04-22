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

const PUSH_DEBOUNCE_MS = 2000;
const BATCH_SIZE = 50;
const TRANSCRIPTION_BATCH_SIZE = 100;

class SyncService {
  private syncing = false;
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  canSync(): boolean {
    return (
      localStorage.getItem("isSignedIn") === "true" &&
      localStorage.getItem("cloudBackupEnabled") === "true" &&
      localStorage.getItem("isSubscribed") === "true"
    );
  }

  async syncAll(): Promise<void> {
    if (this.syncing || !this.canSync()) return;
    this.syncing = true;
    try {
      await this.syncFolders();
      await this.syncNotes();
      await this.syncConversations();
      await this.syncTranscriptions();
      localStorage.setItem("lastSyncedAt", new Date().toISOString());
    } catch (err) {
      console.error("Sync failed:", err);
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
        folder_id: cloudFolderId,
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
        if (!local || cloudFolder.updated_at > local.created_at) {
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
    const pending = (await window.electronAPI.getPendingTranscriptions?.()) ?? [];
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
