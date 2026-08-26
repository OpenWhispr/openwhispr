// window.electronAPI as the renderer sees it: every method here mirrors the
// name, argument order and return value of its ipcHandlers.js passthrough, so a
// drift between SyncService and the real IPC surface shows up as a test failure.

// Fixed credential state for the whole test process; establishValidatedAuth()
// in browserGlobals.js turns it into a validated renderer auth context.
const AUTH_TOKEN = "harness-token";
const AUTH_GENERATION = 0;

// syncAll() asserts the whole dictionary and snippet surface exists before doing
// any work and aborts the pass if a name is missing, so both are present but
// inert — this harness covers notes and folders.
function inertDictionaryApi() {
  return {
    getPendingDictionary: async () => [],
    getPendingDictionaryDeletes: async () => [],
    getDictionaryByClientId: async () => null,
    upsertDictionaryFromCloud: async () => undefined,
    markDictionarySynced: async () => ({ success: true, changes: 1 }),
    hardDeleteDictionary: async () => ({ success: true }),
    clearDictionaryCloudId: async () => ({ success: true }),
    broadcastDictionaryUpdated: async () => undefined,
  };
}

function inertSnippetApi() {
  return {
    getPendingSnippets: async () => [],
    getPendingSnippetDeletes: async () => [],
    getSnippetForCloudMerge: async () => null,
    upsertSnippetFromCloud: async () => undefined,
    markSnippetSynced: async () => ({ success: true, changes: 1 }),
    hardDeleteSnippet: async () => ({ success: true }),
    clearSnippetCloudId: async () => ({ success: true }),
    broadcastSnippetsUpdated: async () => undefined,
  };
}

function createElectronApi(db, options = {}) {
  if (!db) throw new TypeError("createElectronApi requires a DatabaseManager");
  const cloud = options.cloud;
  // UI signals SyncService rebroadcasts through the main process
  // (space-revoked, note-relocated, …), recorded for assertions.
  const syncEvents = [];

  return {
    syncEvents,

    cloudApiRequest: async (opts) => {
      if (!cloud) throw new Error("no fake cloud wired into this electronAPI");
      return cloud.request(opts);
    },

    // Auth
    authGetTokenState: async () => ({ token: AUTH_TOKEN, generation: AUTH_GENERATION }),

    emitSyncEvent: async (name, payload) => {
      syncEvents.push({ name, payload });
      return { success: true };
    },

    // Notes
    getNote: async (id) => db.getNote(id),
    updateNote: async (id, updates) => db.updateNote(id, updates),
    getPendingNotes: async (spaceKind) => db.getPendingNotes(spaceKind),
    getPendingNoteDeletes: async () => db.getPendingNoteDeletes(),
    getNoteByClientId: async (clientNoteId) => db.getNoteByClientId(clientNoteId),
    upsertNoteFromCloud: async (cloudNote, localFolderId, localSpaceId) =>
      db.upsertNoteFromCloud(cloudNote, localFolderId, localSpaceId),
    acknowledgeNoteCreate: async (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged) =>
      db.acknowledgeNoteCreate(id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, settleIfUnchanged),
    markNoteSyncedIfUnchanged: async (id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId) =>
      db.markNoteSyncedIfUnchanged(id, snapshot, expectedCloudId, cloudUpdatedAt, ownerUserId),
    markNoteSyncError: async (id) => db.markNoteSyncError(id),
    setNoteOwnerFromCloud: async (id, ownerUserId) => db.setNoteOwnerFromCloud(id, ownerUserId),
    countTeamNotesMissingOwner: async () => db.countTeamNotesMissingOwner(),
    restoreNoteAfterDeniedDelete: async (id) => db.restoreNoteAfterDeniedDelete(id),
    hardDeleteNote: async (id) => db.hardDeleteNote(id),

    // Folders
    getFolders: async (spaceId) => db.getFolders(spaceId),
    getPendingFolders: async (spaceKind) => db.getPendingFolders(spaceKind),
    getPendingFolderDeletes: async () => db.getPendingFolderDeletes(),
    getFolderByClientId: async (clientFolderId) => db.getFolderByClientId(clientFolderId),
    upsertFolderFromCloud: async (cloudFolder, localSpaceId) =>
      db.upsertFolderFromCloud(cloudFolder, localSpaceId),
    acknowledgeFolderCreate: async (
      id,
      snapshot,
      expectedCloudId,
      responseClientFolderId,
      cloudId,
      cloudUpdatedAt
    ) =>
      db.acknowledgeFolderCreate(
        id,
        snapshot,
        expectedCloudId,
        responseClientFolderId,
        cloudId,
        cloudUpdatedAt
      ),
    markFolderSyncedIfUnchanged: async (id, snapshot, expectedCloudId) =>
      db.markFolderSyncedIfUnchanged(id, snapshot, expectedCloudId),
    restoreFolderAfterDeniedDelete: async (id) => db.restoreFolderAfterDeniedDelete(id),
    relocateRevokedFolder: async (id, privateSpaceId, preserveFolder) =>
      db.relocateRevokedFolder(id, privateSpaceId, preserveFolder),
    getFolderIdMap: async () => db.getFolderIdMap(),
    hardDeleteFolder: async (id) => db.hardDeleteFolder(id),

    // Spaces
    getSpaces: async () => db.getSpaces(),
    upsertSpaceFromCloud: async (cloudSpace) => db.upsertSpaceFromCloud(cloudSpace),
    setSpaceSyncStatus: async (id, status) => db.setSpaceSyncStatus(id, status),
    purgeSpace: async (id, purgeOptions) => {
      // Mirrors the db-purge-space handler's stale-generation refusal.
      if (
        purgeOptions?.expectedAuthGeneration !== undefined &&
        purgeOptions.expectedAuthGeneration !== AUTH_GENERATION
      ) {
        return {
          success: false,
          error: "Authentication context changed before account cleanup",
          code: "AUTH_CONTEXT_CHANGED",
        };
      }
      return db.purgeSpace(id, purgeOptions);
    },

    // Conversations
    getAgentConversation: async (id) => db.getAgentConversation(id),
    getPendingConversations: async () => db.getPendingConversations(),
    getPendingConversationDeletes: async () => db.getPendingConversationDeletes(),
    getConversationByClientId: async (clientId) => db.getConversationByClientId(clientId),
    upsertConversationFromCloud: async (cloudConv, messages) =>
      db.upsertConversationFromCloud(cloudConv, messages),
    acknowledgeConversationCreate: async (id, snapshot, cloudId) =>
      db.acknowledgeConversationCreate(id, snapshot, cloudId),
    markConversationSynced: async (id, cloudId) => db.markConversationSynced(id, cloudId),
    hardDeleteConversation: async (id) => db.hardDeleteConversation(id),

    // Transcriptions
    getTranscriptionById: async (id) => db.getTranscriptionById(id),
    getPendingTranscriptions: async () => db.getPendingTranscriptions(),
    getPendingTranscriptionDeletes: async () => db.getPendingTranscriptionDeletes(),
    getTranscriptionByClientId: async (clientId) => db.getTranscriptionByClientId(clientId),
    upsertTranscriptionFromCloud: async (cloudTranscription) =>
      db.upsertTranscriptionFromCloud(cloudTranscription),
    markTranscriptionSynced: async (id, cloudId) => db.markTranscriptionSynced(id, cloudId),
    hardDeleteTranscription: async (id) => db.hardDeleteTranscription(id),

    ...inertDictionaryApi(),
    ...inertSnippetApi(),
  };
}

module.exports = { createElectronApi, AUTH_TOKEN, AUTH_GENERATION };
