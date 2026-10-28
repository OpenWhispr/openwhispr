// window.electronAPI as the renderer sees it: every method here mirrors the
// name, argument order and return value of its ipcHandlers.js passthrough, so a
// drift between SyncService and the real IPC surface shows up as a test failure.

// Fixed credential state for the whole test process; establishValidatedAuth()
// in browserGlobals.js turns it into a validated renderer auth context.
const AUTH_TOKEN = "harness-token";
const AUTH_GENERATION = 0;

// Mirrors the push-ack and pull-write handlers: an ack sent, or a pulled row
// fetched, under a sign-in that has since changed is dropped (isStaleSyncAck in
// ipcHandlers.js).
const STALE_SYNC_ACK = { success: false, changes: 0, stale: true };

// syncAll() asserts the whole snippet surface exists before doing any work and
// aborts the pass if a name is missing, so it is present but inert unless a
// test opts into the real bindings with { snippets: true }.
function snippetApi(db, authState) {
  return {
    getPendingSnippets: async () => db.getPendingSnippets(),
    getPendingSnippetDeletes: async () => db.getPendingSnippetDeletes(),
    getSnippetForCloudMerge: async (cloudEntry) => db.getSnippetForCloudMerge(cloudEntry),
    upsertSnippetFromCloud: async (cloudEntry, expectedAuthGeneration) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.upsertSnippetFromCloud(cloudEntry),
    markSnippetSynced: async (
      id,
      cloudId,
      serverUpdatedAt,
      expectedTrigger,
      expectedReplacement,
      expectedAuthGeneration
    ) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.markSnippetSynced(id, cloudId, serverUpdatedAt, expectedTrigger, expectedReplacement),
    hardDeleteSnippet: async (id) => db.hardDeleteSnippet(id),
    clearSnippetCloudId: async (id) => db.clearSnippetCloudId(id),
    broadcastSnippetsUpdated: async () => ({ success: true }),
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

// Every analytics binding syncPendingAnalytics reaches for. A missing one does
// not fail loudly here -- SyncService catches the TypeError and logs it -- so
// the pass silently does nothing and the test that asserts it drained still
// reads as a behaviour failure. Keep this in step with preload.js.
function inertAnalyticsApi() {
  return {
    getPendingAnalyticsClear: async () => null,
    completeAnalyticsClear: async () => ({ success: true, deleted: 0 }),
    getPendingAnalyticsDeletes: async () => [],
    hardDeleteAnalyticsEvents: async () => ({ success: true, deleted: 0 }),
    getPendingAnalyticsEvents: async () => [],
    markAnalyticsEventsSynced: async () => ({ success: true, updated: 0 }),
    countUnclaimedAnalyticsEvents: async () => 0,
    countAnalyticsEventsAwaitingUpload: async () => 0,
  };
}

function createElectronApi(db, options = {}) {
  if (!db) throw new TypeError("createElectronApi requires a DatabaseManager");
  const cloud = options.cloud;
  // UI signals SyncService rebroadcasts through the main process
  // (space-revoked, note-relocated, …), recorded for assertions.
  const syncEvents = [];
  // The main process's token generation. A test bumps it to stand in for an
  // account switch while a pass is in flight.
  const authState = {
    generation: AUTH_GENERATION,
    isStale: (expected) => expected !== undefined && expected !== authState.generation,
  };

  return {
    syncEvents,
    authState,

    cloudApiRequest: async (opts) => {
      if (!cloud) throw new Error("no fake cloud wired into this electronAPI");
      // Mirrors cloudApiRequest.js's fence: a request pinned to another
      // sign-in is refused before it reaches the cloud.
      if (!opts?.public && authState.isStale(opts?.expectedAuthGeneration)) {
        return {
          success: false,
          error: "Authentication context changed",
          code: "AUTH_CONTEXT_CHANGED",
        };
      }
      return cloud.request(opts);
    },

    // Auth
    authGetTokenState: async () => ({ token: AUTH_TOKEN, generation: authState.generation }),

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
    acknowledgeNoteCreate: async (id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, options) =>
      db.acknowledgeNoteCreate(id, snapshot, cloudId, cloudUpdatedAt, ownerUserId, options),
    markNoteSyncedIfUnchanged: async (
      id,
      snapshot,
      expectedCloudId,
      cloudUpdatedAt,
      ownerUserId,
      cloudRevision,
      cloudNote
    ) =>
      db.markNoteSyncedIfUnchanged(
        id,
        snapshot,
        expectedCloudId,
        cloudUpdatedAt,
        ownerUserId,
        cloudRevision,
        cloudNote
      ),
    setNoteCloudBase: async (id, cloudUpdatedAt, cloudRevision, options) =>
      db.setNoteCloudBase(id, cloudUpdatedAt, cloudRevision, options),
    markNoteSyncError: async (id) => db.markNoteSyncError(id),
    setNoteOwnerFromCloud: async (id, ownerUserId) => db.setNoteOwnerFromCloud(id, ownerUserId),
    countTeamNotesMissingOwner: async () => db.countTeamNotesMissingOwner(),
    countNotesMissingRevision: async (spaceKind) => db.countNotesMissingRevision(spaceKind),
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
    upsertConversationFromCloud: async (cloudConv, messages, expectedAuthGeneration) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.upsertConversationFromCloud(cloudConv, messages),
    acknowledgeConversationCreate: async (id, snapshot, cloudId, accountId) =>
      db.acknowledgeConversationCreate(id, snapshot, cloudId, accountId || undefined),
    markConversationSynced: async (id, cloudId, accountId) =>
      db.markConversationSynced(id, cloudId, accountId || undefined),
    hardDeleteConversation: async (id) => db.hardDeleteConversation(id),

    // Transcriptions
    getTranscriptionById: async (id) => db.getTranscriptionById(id),
    getPendingTranscriptions: async () => db.getPendingTranscriptions(),
    getPendingTranscriptionDeletes: async () => db.getPendingTranscriptionDeletes(),
    getTranscriptionByClientId: async (clientId) => db.getTranscriptionByClientId(clientId),
    upsertTranscriptionFromCloud: async (cloudTranscription, expectedAuthGeneration) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.upsertTranscriptionFromCloud(cloudTranscription),
    markTranscriptionSynced: async (id, cloudId, expectedAuthGeneration) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.markTranscriptionSynced(id, cloudId),
    hardDeleteTranscription: async (id) => db.hardDeleteTranscription(id),

    // Dictionary
    getPendingDictionary: async () => db.getPendingDictionary(),
    getPendingDictionaryDeletes: async () => db.getPendingDictionaryDeletes(),
    getDictionaryByClientId: async (clientDictId) => db.getDictionaryEntryByClientId(clientDictId),
    upsertDictionaryFromCloud: async (cloudEntry, expectedAuthGeneration) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.upsertDictionaryFromCloud(cloudEntry),
    markDictionarySynced: async (
      id,
      cloudId,
      serverUpdatedAt,
      expectedWord,
      expectedSource,
      serverSource,
      expectedAuthGeneration
    ) =>
      authState.isStale(expectedAuthGeneration)
        ? STALE_SYNC_ACK
        : db.markDictionaryEntrySynced(
            id,
            cloudId,
            serverUpdatedAt,
            expectedWord,
            expectedSource,
            serverSource
          ),
    hardDeleteDictionary: async (id) => db.hardDeleteDictionaryEntry(id),
    clearDictionaryCloudId: async (id) => db.clearDictionaryCloudId(id),
    // The real handler re-reads the words to broadcast them; there are no windows here.
    broadcastDictionaryUpdated: async () => ({ success: true }),

    ...(options.snippets ? snippetApi(db, authState) : inertSnippetApi()),
    ...inertAnalyticsApi(),
  };
}

module.exports = { createElectronApi, AUTH_TOKEN, AUTH_GENERATION };
