const test = require("node:test");
const assert = require("node:assert/strict");

const folder = {
  id: 1,
  name: "Projects",
  is_default: 0,
  sort_order: 2,
  created_at: "2026-07-07T00:00:00.000Z",
  updated_at: "2026-07-07T00:01:00.000Z",
  client_folder_id: "folder-client-1",
  cloud_id: null,
  sync_status: "pending",
  deleted_at: null,
};

const note = {
  id: 2,
  title: "Local note",
  content: "Body",
  enhanced_content: null,
  enhancement_prompt: null,
  enhanced_at_content_hash: null,
  note_type: "personal",
  source_file: null,
  audio_duration_seconds: null,
  folder_id: 1,
  transcript: "Transcript",
  calendar_event_id: null,
  participants: null,
  diarization_enabled: null,
  expected_speaker_count: null,
  cloud_id: null,
  created_at: "2026-07-07T00:00:00.000Z",
  updated_at: "2026-07-07T00:01:00.000Z",
  client_note_id: "note-client-1",
  sync_status: "pending",
  deleted_at: null,
};

const transcription = {
  id: 3,
  text: "hello",
  raw_text: "hello",
  timestamp: "2026-07-07T00:00:00.000Z",
  created_at: "2026-07-07T00:00:00.000Z",
  has_audio: 0,
  audio_duration_ms: null,
  provider: "whisper",
  model: "base",
  status: "completed",
  error_message: null,
  error_code: null,
  client_transcription_id: "transcription-client-1",
  cloud_id: null,
  sync_status: "pending",
  deleted_at: null,
};

const conversationPreview = {
  id: 4,
  title: "Chat",
  created_at: "2026-07-07T00:00:00.000Z",
  updated_at: "2026-07-07T00:01:00.000Z",
  cloud_id: null,
  client_conversation_id: "conversation-client-1",
  sync_status: "pending",
  deleted_at: null,
  message_count: 1,
  last_message: "answer",
  last_message_role: "assistant",
};

test("exportLocalBackup includes local data without requiring account state", async () => {
  global.window = {
    electronAPI: {
      getFolders: async () => [folder],
      getNotes: async (noteType, limit, folderId) => {
        assert.equal(noteType, null);
        assert.equal(limit, 100000);
        assert.equal(folderId, null);
        return [note];
      },
      getTranscriptions: async (limit, options) => {
        assert.equal(limit, 100000);
        assert.deepEqual(options, { includeDiscarded: true });
        return [transcription];
      },
      getDictionary: async () => ["OpenWhispr", "local"],
      getAgentConversations: async (limit) => {
        assert.equal(limit, 100000);
        return [conversationPreview];
      },
      getAgentConversation: async (id) => ({
        ...conversationPreview,
        id,
        messages: [
          {
            id: 5,
            conversation_id: id,
            role: "assistant",
            content: "answer",
            metadata: "{\"source\":\"local\"}",
            created_at: "2026-07-07T00:01:00.000Z",
          },
        ],
      }),
    },
  };
  const { exportLocalBackup } = await import("../../src/services/LocalBackupService.ts");

  const pkg = await exportLocalBackup();

  assert.equal(pkg.kind, "openwhispr.localBackup");
  assert.equal(pkg.version, 1);
  assert.equal(pkg.folders[0].client_folder_id, "folder-client-1");
  assert.equal(pkg.notes[0].client_note_id, "note-client-1");
  assert.equal(pkg.transcriptions[0].client_transcription_id, "transcription-client-1");
  assert.deepEqual(pkg.dictionary.words, ["OpenWhispr", "local"]);
  assert.equal(pkg.conversations[0].client_conversation_id, "conversation-client-1");
  assert.deepEqual(pkg.conversations[0].messages[0].metadata, { source: "local" });
});

test("importLocalBackup upserts by client ids and maps folders", async () => {
  const calls = {
    folders: [],
    notes: [],
    transcriptions: [],
    dictionary: [],
    conversations: [],
  };
  global.window = {
    electronAPI: {
      getDictionary: async () => ["existing"],
      setDictionary: async (words) => {
        calls.dictionary.push(words);
        return { success: true };
      },
      upsertFolderFromCloud: async (payload) => {
        calls.folders.push(payload);
        return { ...folder, id: 10, client_folder_id: payload.client_folder_id };
      },
      upsertNoteFromCloud: async (payload, localFolderId) => {
        calls.notes.push({ payload, localFolderId });
        return { ...note, id: 20, client_note_id: payload.client_note_id, folder_id: localFolderId };
      },
      upsertTranscriptionFromCloud: async (payload) => {
        calls.transcriptions.push(payload);
        return { ...transcription, id: 30 };
      },
      upsertConversationFromCloud: async (payload, messages) => {
        calls.conversations.push({ payload, messages });
      },
    },
  };
  const { importLocalBackup } = await import("../../src/services/LocalBackupService.ts");

  const result = await importLocalBackup({
    kind: "openwhispr.localBackup",
    version: 1,
    exportedAt: "2026-07-07T00:00:00.000Z",
    folders: [folder],
    notes: [note],
    transcriptions: [transcription],
    dictionary: { words: ["OpenWhispr"] },
    conversations: [
      {
        ...conversationPreview,
        messages: [{ role: "user", content: "question", metadata: null }],
      },
    ],
  });

  assert.deepEqual(result, {
    folders: 1,
    notes: 1,
    transcriptions: 1,
    dictionaryWords: 1,
    conversations: 1,
  });
  assert.equal(calls.folders[0].id, null);
  assert.equal(calls.notes[0].payload.id, null);
  assert.equal(calls.notes[0].localFolderId, 10);
  assert.equal(calls.transcriptions[0].id, null);
  assert.deepEqual(calls.dictionary[0], ["existing", "OpenWhispr"]);
  assert.equal(calls.conversations[0].payload.id, null);
  assert.deepEqual(calls.conversations[0].messages, [
    { role: "user", content: "question", metadata: null },
  ]);
});
