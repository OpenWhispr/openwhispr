import type {
  ConversationPreview,
  DictionaryEntryItem,
  FolderItem,
  NoteItem,
  TranscriptionItem,
} from "../types/electron";

type ElectronApi = NonNullable<typeof window.electronAPI>;

interface AgentMessageBackup {
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> | string | null;
  created_at?: string;
}

interface ConversationBackup extends ConversationPreview {
  messages: AgentMessageBackup[];
}

export interface LocalBackupPackage {
  kind: "openwhispr.localBackup";
  version: 1;
  exportedAt: string;
  folders: FolderItem[];
  notes: NoteItem[];
  transcriptions: TranscriptionItem[];
  dictionary: {
    words: string[];
    entries?: DictionaryEntryItem[];
  };
  conversations: ConversationBackup[];
}

export interface LocalBackupImportResult {
  folders: number;
  notes: number;
  transcriptions: number;
  dictionaryWords: number;
  conversations: number;
}

const BACKUP_KIND = "openwhispr.localBackup" as const;
const BACKUP_VERSION = 1 as const;
const BACKUP_LIMIT = 100000;

export async function exportLocalBackup(): Promise<LocalBackupPackage> {
  const api = requireElectronApi([
    "getFolders",
    "getNotes",
    "getTranscriptions",
    "getDictionary",
  ]);

  const [folders, notes, transcriptions, words, conversations] = await Promise.all([
    api.getFolders(),
    api.getNotes(null, BACKUP_LIMIT, null),
    api.getTranscriptions(BACKUP_LIMIT, { includeDiscarded: true }),
    api.getDictionary(),
    exportConversations(api),
  ]);

  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    folders,
    notes,
    transcriptions,
    dictionary: { words },
    conversations,
  };
}

export async function importLocalBackup(
  backup: LocalBackupPackage
): Promise<LocalBackupImportResult> {
  assertBackupPackage(backup);
  const api = requireElectronApi([
    "upsertFolderFromCloud",
    "upsertNoteFromCloud",
    "upsertTranscriptionFromCloud",
    "getDictionary",
    "setDictionary",
  ]);

  const localFolderIdsByBackupId = new Map<number, number>();
  for (const folder of backup.folders) {
    const restored = await api.upsertFolderFromCloud!(toLocalFolderPayload(folder));
    localFolderIdsByBackupId.set(folder.id, restored.id);
  }

  for (const note of backup.notes) {
    const localFolderId =
      note.folder_id == null ? null : (localFolderIdsByBackupId.get(note.folder_id) ?? null);
    await api.upsertNoteFromCloud!(toLocalNotePayload(note), localFolderId);
  }

  for (const transcription of backup.transcriptions) {
    await api.upsertTranscriptionFromCloud!(toLocalTranscriptionPayload(transcription));
  }

  await importDictionary(api, backup.dictionary.words);
  await importConversations(api, backup.conversations);

  return {
    folders: backup.folders.length,
    notes: backup.notes.length,
    transcriptions: backup.transcriptions.length,
    dictionaryWords: backup.dictionary.words.length,
    conversations: backup.conversations.length,
  };
}

async function exportConversations(api: ElectronApi): Promise<ConversationBackup[]> {
  if (!api.getAgentConversations || !api.getAgentConversation) return [];
  const previews = await api.getAgentConversations(BACKUP_LIMIT);
  const fullConversations = await Promise.all(
    previews.map(async (preview) => ({
      preview,
      conversation: await api.getAgentConversation?.(preview.id),
    }))
  );

  return fullConversations
    .filter(({ conversation }) => Boolean(conversation))
    .map(({ preview, conversation }) => ({
      id: conversation!.id,
      title: conversation!.title,
      archived_at: conversation!.archived_at ?? null,
      cloud_id: conversation!.cloud_id ?? null,
      client_conversation_id:
        preview.client_conversation_id ?? `local-conversation-${conversation!.id}`,
      created_at: conversation!.created_at,
      updated_at: conversation!.updated_at,
      message_count: conversation!.messages.length,
      last_message: conversation!.messages.at(-1)?.content ?? null,
      last_message_role: conversation!.messages.at(-1)?.role ?? null,
      messages: conversation!.messages.map((message) => ({
        role: message.role,
        content: message.content,
        metadata: parseMetadata(message.metadata),
        created_at: message.created_at,
      })),
    }));
}

async function importDictionary(api: ElectronApi, incomingWords: string[]): Promise<void> {
  const existingWords = await api.getDictionary();
  const wordsByLower = new Map<string, string>();
  for (const word of [...existingWords, ...incomingWords]) {
    const trimmed = typeof word === "string" ? word.trim() : "";
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!wordsByLower.has(key)) wordsByLower.set(key, trimmed);
  }
  await api.setDictionary(Array.from(wordsByLower.values()));
}

async function importConversations(
  api: ElectronApi,
  conversations: ConversationBackup[]
): Promise<void> {
  if (conversations.length === 0) return;
  if (!api.upsertConversationFromCloud) {
    throw new Error("Local backup import requires upsertConversationFromCloud IPC");
  }

  for (const conversation of conversations) {
    await api.upsertConversationFromCloud(
      toLocalConversationPayload(conversation),
      conversation.messages.map((message) => ({ ...message }))
    );
  }
}

function toLocalFolderPayload(folder: FolderItem): Record<string, unknown> {
  return {
    id: null,
    client_folder_id: folder.client_folder_id,
    name: folder.name,
    is_default: folder.is_default,
    sort_order: folder.sort_order,
    created_at: folder.created_at,
    updated_at: folder.updated_at,
  };
}

function toLocalNotePayload(note: NoteItem): Record<string, unknown> {
  return {
    id: null,
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
    created_at: note.created_at,
    updated_at: note.updated_at,
  };
}

function toLocalTranscriptionPayload(transcription: TranscriptionItem): Record<string, unknown> {
  return {
    id: null,
    client_transcription_id: transcription.client_transcription_id,
    text: transcription.text,
    raw_text: transcription.raw_text,
    provider: transcription.provider,
    model: transcription.model,
    audio_duration_ms: transcription.audio_duration_ms,
    status: transcription.status,
    created_at: transcription.created_at,
  };
}

function toLocalConversationPayload(conversation: ConversationBackup): Record<string, unknown> {
  return {
    id: null,
    client_conversation_id:
      conversation.client_conversation_id ?? `local-conversation-${conversation.id}`,
    title: conversation.title,
    note_id: null,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
  };
}

function parseMetadata(
  value: string | Record<string, unknown> | undefined
): Record<string, unknown> | string | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function assertBackupPackage(value: LocalBackupPackage): void {
  if (!value || value.kind !== BACKUP_KIND || value.version !== BACKUP_VERSION) {
    throw new Error("Unsupported OpenWhispr local backup file");
  }
}

function requireElectronApi<const K extends keyof ElectronApi>(methods: K[]): ElectronApi {
  if (typeof window === "undefined" || !window.electronAPI) {
    throw new Error("OpenWhispr local backup requires the desktop app");
  }
  const missing = methods.filter((method) => typeof window.electronAPI[method] !== "function");
  if (missing.length > 0) {
    throw new Error(`Local backup IPC bindings missing: ${missing.join(", ")}`);
  }
  return window.electronAPI;
}
