// In-memory stand-in for the cloud API behind window.electronAPI.cloudApiRequest.
// Notes and folders are modelled with the hardened server's real write rules,
// conversations with their create, update, delete and message routes,
// dictionary words and snippets on the read side plus create, update and
// delete, transcriptions with an idempotent create; the other entity types
// exist only so a full syncAll() pass can complete.
//
// Each hardening rule sits behind its own flag so a test can flip the server
// back to the legacy behaviour and prove the client still does not lose data:
//   materialPatchGate  a PATCH that changes nothing does not bump updated_at
//   coalesceOnConflict an absent/null incoming field keeps the stored value
//   staleWriteGuard    a write whose basis predates the stored row is rejected
//   updatedAtClamp     a stored updated_at never moves backwards
//
// Notes and folders keep their scope (space_id, workspace_id) once a write or a
// seed names it; a row nobody scoped carries neither key, as before teamspaces.
// seedSpace lists a teamspace under /api/me/spaces (a 404 until one is seeded,
// the pre-teamspace API) and can file the rows a test seeds without a scope
// into it; a client's write without one stays personal, as on the server.
// Two more model the current server and are off unless a test asks for them:
//   revisionGuard      note writes advance `revision`, and a PATCH whose
//                      base_revision isn't the stored one gets the server's
//                      409 note_version_conflict with the current row
//   serverDate         every answer carries the server clock as an HTTP Date
//                      header would (whole seconds), read from setClock
//   folderPlacement    a personal note naming a folder takes the folder's
//                      private_workspace_id unless it names its own, and one
//                      that differs is refused (a batch create drops the folder);
//                      an explicit null is the account's defaultWorkspaceId

// The server compares timestamps itself; it must not borrow the client's guard,
// or a client-side regression would be invisible here.
function normalizeTimestamp(value) {
  if (!value) return "";
  const iso = String(value).replace(" ", "T").replace(/Z$/, "");
  return (/\.\d+$/.test(iso) ? iso : `${iso}.000`) + "Z";
}

function sameValue(a, b) {
  return (a ?? null) === (b ?? null);
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const NOTE_FIELDS = [
  "title",
  "content",
  "enhanced_content",
  "note_type",
  "enhancement_prompt",
  "source_file",
  "audio_duration_seconds",
  "folder_id",
  "transcript",
  "enhanced_at_content_hash",
  "participants",
  "calendar_event_id",
  "diarization_enabled",
  "expected_speaker_count",
];

const FOLDER_FIELDS = ["name", "is_default", "sort_order"];

// `messages` rides along as a stored field; of the routes returning a conversation,
// only the list includes it, as api/conversations/list.ts does. A row stored
// without a fork's origin lacks those keys, as every row from an API without
// them does.
const CONVERSATION_FIELDS = [
  "title",
  "archived_at",
  "messages",
  "parent_client_conversation_id",
  "fork_message_count",
  "fork_context",
];

const DICTIONARY_FIELDS = ["word", "source"];

const NOTE_DEFAULTS = {
  title: null,
  content: "",
  enhanced_content: null,
  note_type: "personal",
  enhancement_prompt: null,
  source_file: null,
  audio_duration_seconds: null,
  folder_id: null,
  transcript: null,
  enhanced_at_content_hash: null,
  participants: null,
  calendar_event_id: null,
  diarization_enabled: null,
  expected_speaker_count: null,
};

const FOLDER_DEFAULTS = { name: "", is_default: false, sort_order: 0 };

const CONVERSATION_DEFAULTS = { title: "Untitled", archived_at: null, messages: [] };

const DICTIONARY_DEFAULTS = { word: "", source: "manual" };

const SNIPPET_FIELDS = ["trigger", "replacement"];

const SNIPPET_DEFAULTS = { trigger: "", replacement: "" };

const TRANSCRIPTION_FIELDS = ["text", "raw_text", "status", "provider", "model"];

const TRANSCRIPTION_DEFAULTS = { text: "", raw_text: null, status: "completed" };

const SCOPE_FIELDS = ["workspace_id", "space_id", "private_workspace_id"];

function createFakeCloud(config = {}) {
  const cfg = {
    materialPatchGate: true,
    coalesceOnConflict: true,
    staleWriteGuard: true,
    updatedAtClamp: true,
    revisionGuard: false,
    serverDate: false,
    ...config,
  };

  const notes = new Map();
  const folders = new Map();
  const conversations = new Map();
  const dictionary = new Map();
  const snippets = new Map();
  const transcriptions = new Map();
  const spaces = new Map();
  const log = [];
  const failures = [];
  let seq = 0;
  let clock = () => new Date().toISOString();
  // Where a note or folder no write scoped lands, and whose it is.
  let homeSpace = null;
  let ownerId = null;

  // Real cloud ids are UUIDs; `idSpace` keeps two fake accounts' ids apart too
  // (see createAccountCloud).
  const nextId = (prefix) => `${cfg.idSpace ?? ""}${prefix}-${String(++seq).padStart(4, "0")}`;

  // The server stores timestamps and serves them back as ISO, whatever format
  // the client sent. Local rows carry SQLite's "YYYY-MM-DD HH:MM:SS", so echoing
  // the input back would hide the format skew every pull comparison has to
  // survive.
  const toIso = (value) => normalizeTimestamp(value);

  // A stored updated_at only ever moves forward under the clamp.
  function bump(row, proposed) {
    const candidate = toIso(proposed ?? clock());
    if (cfg.updatedAtClamp && candidate < toIso(row.updated_at)) {
      return row.updated_at;
    }
    return candidate;
  }

  function applyWrite(collection, row, incoming) {
    if (
      cfg.staleWriteGuard &&
      incoming.updated_at &&
      normalizeTimestamp(incoming.updated_at) < normalizeTimestamp(row.updated_at)
    ) {
      throw new HttpError(409, "stale write rejected: basis is older than the stored row", "stale");
    }

    const next = {};
    let material = false;
    for (const key of collection.fields) {
      if (!(key in incoming)) {
        next[key] = row[key];
        continue;
      }
      const value = incoming[key];
      if (cfg.coalesceOnConflict && (value === null || value === undefined) && row[key] != null) {
        next[key] = row[key];
        continue;
      }
      next[key] = value ?? null;
      if (!sameValue(next[key], row[key])) material = true;
    }

    // Without the gate a no-op PATCH still bumps updated_at, which is what hands
    // the next pull a cloud copy that never received the local edit.
    // Scope moves are always material; null is a real value here (a
    // retraction back to personal), never "keep".
    if (collection.scoped) {
      for (const key of SCOPE_FIELDS) {
        if (!(key in incoming)) continue;
        const value = incoming[key] ?? null;
        if (!sameValue(value, row[key])) {
          next[key] = value;
          material = true;
        }
      }
    }

    if (cfg.materialPatchGate && !material) return row;

    Object.assign(row, next);
    row.updated_at = bump(row, incoming.updated_at);
    if (cfg.revisionGuard && collection === noteCollection) row.revision = (row.revision ?? 0) + 1;
    return row;
  }

  // A seeded row (seeded: true) with no scope may land in the home teamspace;
  // a client's create without one is a personal row, as on the server.
  function insertRow(collection, input, { seeded = false } = {}) {
    const clientId = input[collection.clientKey] ?? nextId(`${collection.prefix}-client`);
    const createdAt = toIso(input.created_at ?? clock());
    const row = {
      id: nextId(collection.prefix),
      [collection.clientKey]: clientId,
      ...collection.defaults,
      deleted_at: null,
      created_at: createdAt,
      updated_at: toIso(input.updated_at ?? createdAt),
    };
    for (const key of collection.fields) {
      if (input[key] !== undefined && input[key] !== null) row[key] = input[key];
    }
    if (collection.scoped) {
      if ("space_id" in input || "workspace_id" in input) {
        row.space_id = input.space_id ?? null;
        row.workspace_id =
          input.workspace_id ??
          (row.space_id ? (spaces.get(row.space_id)?.workspace_id ?? null) : null);
      } else if (seeded && homeSpace) {
        row.space_id = homeSpace.id;
        row.workspace_id = homeSpace.workspace_id;
      }
      if (cfg.privateWorkspacePlacement || "private_workspace_id" in input)
        row.private_workspace_id = input.private_workspace_id ?? null;
      if (ownerId && collection === noteCollection) row.user_id = ownerId;
    }
    if (cfg.revisionGuard && collection === noteCollection) row.revision = 0;
    collection.store.set(row.id, row);
    return row;
  }

  // As lib/notes-service.ts compares them, a folder from before placement (null) differs from
  // the default named explicitly.
  function placeInFolder(input, existing, { dropFolder = false } = {}) {
    if (!cfg.folderPlacement || !input.folder_id || input.space_id) return input;
    const folder = folders.get(input.folder_id);
    if (!folder) return input;
    const folderPlacement = folder.private_workspace_id ?? null;
    if (!("private_workspace_id" in input) || existing?.folder_id === input.folder_id) {
      return { ...input, private_workspace_id: folderPlacement };
    }
    if ((input.private_workspace_id ?? cfg.defaultWorkspaceId ?? null) === folderPlacement) {
      return input;
    }
    if (dropFolder) return { ...input, folder_id: null };
    throw new HttpError(400, "Folder not found");
  }

  function findByClientId(collection, clientId) {
    if (!clientId) return null;
    for (const row of collection.store.values()) {
      if (row[collection.clientKey] === clientId) return row;
    }
    return null;
  }

  // Creates upsert by client id, so a retried batch returns the existing row
  // instead of forking a duplicate. As lib/notes-service.ts, a note's upsert
  // keeps tombstones unchanged. A folder's, as lib/folders-service.ts, revives it.
  function upsertRow(collection, input) {
    const existing = findByClientId(collection, input[collection.clientKey]);
    if (!existing) return insertRow(collection, input);
    if (existing.deleted_at && collection === noteCollection) return existing;
    if (existing.deleted_at && collection === folderCollection) existing.deleted_at = null;
    return applyWrite(collection, existing, input);
  }

  // Dictionary and snippet creates, as lib/dictionary-service.ts and
  // lib/snippet-service.ts upsert them: a word or trigger is unique per user
  // whatever its case, tombstones included, so a create that matches one takes
  // the row over (the new writer's client id), revives it and keeps a manual
  // source; failing that, a known client id renames its row. updated_at is
  // always the server's clock: a client's value could land behind another
  // device's delta cursor.
  function upsertKeyedRow(collection, keyField, input) {
    const key = String(input[keyField] ?? "").toLowerCase();
    const rows = [...collection.store.values()];
    const byKey = rows.find((row) => String(row[keyField]).toLowerCase() === key);
    const byClientId = findByClientId(collection, input[collection.clientKey]);
    if (byKey && byClientId && byClientId !== byKey) {
      throw new HttpError(409, `another ${collection.prefix} already uses that ${keyField}`);
    }
    const existing = byKey ?? byClientId;
    if (!existing) {
      const row = insertRow(collection, input);
      row.updated_at = toIso(clock());
      return row;
    }
    for (const field of collection.fields) {
      if (input[field] === undefined || input[field] === null) continue;
      existing[field] =
        field === "source" && existing.source === "manual" ? "manual" : input[field];
    }
    if (input[collection.clientKey]) existing[collection.clientKey] = input[collection.clientKey];
    existing.deleted_at = null;
    existing.updated_at = toIso(clock());
    return existing;
  }

  // As lib/transcriptions-service.ts: a create is an upsert on the client id,
  // so a retried push returns the row it made the first time. A tombstone takes
  // the write and stays one.
  function upsertTranscription(input) {
    const existing = findByClientId(transcriptionCollection, input.client_transcription_id);
    if (!existing) return insertRow(transcriptionCollection, input);
    for (const field of TRANSCRIPTION_FIELDS) {
      if (input[field] !== undefined) existing[field] = input[field];
    }
    return existing;
  }

  function requireLive(collection, id) {
    const row = collection.store.get(id);
    if (!row || row.deleted_at)
      throw new HttpError(404, `${collection.prefix} not found`, "not_found");
    return row;
  }

  function tombstone(collection, id) {
    const row = collection.store.get(id);
    if (!row) throw new HttpError(404, `${collection.prefix} not found`, "not_found");
    const at = bump(row, clock());
    row.deleted_at = at;
    row.updated_at = at;
    return row;
  }

  const noteCollection = {
    store: notes,
    fields: NOTE_FIELDS,
    defaults: NOTE_DEFAULTS,
    clientKey: "client_note_id",
    prefix: "note",
    scoped: true,
  };
  const folderCollection = {
    store: folders,
    fields: FOLDER_FIELDS,
    defaults: FOLDER_DEFAULTS,
    clientKey: "client_folder_id",
    prefix: "folder",
    scoped: true,
  };
  const conversationCollection = {
    store: conversations,
    fields: CONVERSATION_FIELDS,
    defaults: CONVERSATION_DEFAULTS,
    clientKey: "client_conversation_id",
    prefix: "conv",
  };
  const dictionaryCollection = {
    store: dictionary,
    fields: DICTIONARY_FIELDS,
    defaults: DICTIONARY_DEFAULTS,
    clientKey: "client_dict_id",
    prefix: "dict",
  };
  const snippetCollection = {
    store: snippets,
    fields: SNIPPET_FIELDS,
    defaults: SNIPPET_DEFAULTS,
    clientKey: "client_snippet_id",
    prefix: "snip",
  };

  const transcriptionCollection = {
    store: transcriptions,
    fields: TRANSCRIPTION_FIELDS,
    defaults: TRANSCRIPTION_DEFAULTS,
    clientKey: "client_transcription_id",
    prefix: "trans",
  };

  function requireLiveConversation(id) {
    const row = conversations.get(id);
    if (!row || row.deleted_at) throw new HttpError(404, "Conversation not found");
    return row;
  }

  function appendConversationMessage(row, { role, content, metadata }) {
    const message = {
      id: nextId("msg"),
      conversation_id: row.id,
      role,
      content,
      metadata: metadata ?? null,
      created_at: toIso(clock()),
    };
    row.messages.push(message);
    return message;
  }

  function conversationResponse(row) {
    const { messages: _messages, ...conversation } = row;
    return conversation;
  }

  // Snapshot paging walks created_at backwards from `before` and hides
  // tombstones; delta paging walks updated_at forwards from `since` and must
  // carry tombstones, since that is how a delete reaches the other device.
  function page(collection, query, orderKey) {
    const limitRaw = Number(query.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const since = query.get("since");
    const sinceId = query.get("since_id");
    const before = query.get("before");
    const beforeId = query.get("before_id");
    let rows = [...collection.store.values()];

    if (since) {
      const bound = normalizeTimestamp(since);
      rows = rows.filter((r) => {
        const timestampOrder = compare(normalizeTimestamp(r.updated_at), bound);
        return timestampOrder > 0 || (timestampOrder === 0 && (!sinceId || r.id > sinceId));
      });
      rows.sort(
        (a, b) =>
          compare(normalizeTimestamp(a.updated_at), normalizeTimestamp(b.updated_at)) ||
          compare(a.id, b.id)
      );
    } else {
      rows = rows.filter((r) => !r.deleted_at);
      if (before) {
        const bound = normalizeTimestamp(before);
        rows = rows.filter((r) => {
          const timestampOrder = compare(normalizeTimestamp(r[orderKey]), bound);
          return timestampOrder < 0 || (timestampOrder === 0 && !!beforeId && r.id < beforeId);
        });
      }
      rows.sort(
        (a, b) =>
          compare(normalizeTimestamp(b[orderKey]), normalizeTimestamp(a[orderKey])) ||
          compare(b.id, a.id)
      );
    }

    return rows.slice(0, limit).map((row) => structuredClone(row));
  }

  // The dictionary list pages forwards, unlike notes: the default list and its
  // `cursor` continuation walk live rows by (created_at, id); `since` streams
  // every row, tombstones included, by (updated_at, id). Either timestamp
  // without its id half is an inclusive bound, as on the server.
  function dictionaryPage(query, collection = dictionaryCollection) {
    const limitRaw = Number(query.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200;
    const since = query.get("since");
    const cursor = query.get("cursor");
    const sinceId = query.get("since_id");
    const cursorId = query.get("cursor_id");
    if ((sinceId && !since) || (cursorId && !cursor) || (since && cursor)) {
      throw new HttpError(400, "malformed dictionary keyset", "bad_request");
    }

    const orderKey = since ? "updated_at" : "created_at";
    const bound = since ?? cursor;
    const boundId = since ? sinceId : cursorId;
    let rows = [...collection.store.values()];
    if (!since) rows = rows.filter((r) => !r.deleted_at);
    if (bound) {
      const at = normalizeTimestamp(bound);
      rows = rows.filter((r) => {
        const timestampOrder = compare(normalizeTimestamp(r[orderKey]), at);
        return boundId
          ? timestampOrder > 0 || (timestampOrder === 0 && r.id > boundId)
          : timestampOrder >= 0;
      });
    }
    rows.sort(
      (a, b) =>
        compare(normalizeTimestamp(a[orderKey]), normalizeTimestamp(b[orderKey])) ||
        compare(a.id, b.id)
    );

    return {
      entries: rows.slice(0, limit).map((row) => structuredClone(row)),
      hasMore: rows.length > limit,
    };
  }

  function handle(method, pathname, query, body) {
    // Only a cloud configured with `workspaces` lists them, as /api/workspaces and
    // /api/workspaces/:id do (a 404 for a workspace the account isn't in).
    if (method === "GET" && cfg.workspaces && pathname.startsWith("/api/workspaces")) {
      if (pathname === "/api/workspaces") return { data: structuredClone(cfg.workspaces) };
      const workspace = cfg.workspaces.find((w) => pathname === `/api/workspaces/${w.id}`);
      if (!workspace) throw new HttpError(404, "Workspace not found");
      return { data: structuredClone(workspace) };
    }
    // As the API's placement backfill: exactly the id and placement, written only where the
    // row has none (no bump otherwise), and the row returned as stored.
    if (method === "PATCH" && body?.placement_backfill === true) {
      const collection = pathname === "/api/notes/update" ? noteCollection : folderCollection;
      const keys = Object.keys(body).sort().join(",");
      if (keys !== "id,placement_backfill,private_workspace_id") {
        throw new HttpError(400, "Invalid placement backfill", "invalid_placement_backfill");
      }
      const row = requireLive(collection, body.id);
      if (row.private_workspace_id == null) {
        row.private_workspace_id = body.private_workspace_id;
        row.updated_at = bump(row);
        // As relocate_private_folder_children: a folder's notes follow its placement.
        if (collection === folderCollection) {
          for (const note of notes.values()) {
            if (note.folder_id !== row.id || note.space_id || note.deleted_at) continue;
            note.private_workspace_id = row.private_workspace_id;
            note.updated_at = bump(note);
          }
        }
      }
      return row;
    }
    const route = `${method} ${pathname}`;
    switch (route) {
      case "POST /api/notes/create": {
        const existing = findByClientId(noteCollection, body?.client_note_id);
        return {
          ...upsertRow(noteCollection, placeInFolder(body ?? {}, existing)),
          row_created: !existing,
          write_applied: !existing?.deleted_at,
        };
      }
      case "POST /api/notes/batch-create": {
        const inputs = Array.isArray(body?.notes) ? body.notes : [];
        const created = [];
        for (const input of inputs) {
          const existing = findByClientId(noteCollection, input.client_note_id);
          const row = upsertRow(
            noteCollection,
            placeInFolder(input, existing, { dropFolder: true })
          );
          created.push({ ...row, row_created: !existing, write_applied: !existing?.deleted_at });
        }
        return { created };
      }
      case "PATCH /api/notes/update": {
        const { id, ...updates } = body ?? {};
        const row = requireLive(noteCollection, id);
        if (
          cfg.revisionGuard &&
          updates.base_revision !== undefined &&
          updates.base_revision !== row.revision
        ) {
          throw new HttpError(
            409,
            "Note was modified since it was last fetched",
            "note_version_conflict",
            { note: structuredClone(row) }
          );
        }
        return applyWrite(noteCollection, row, placeInFolder(updates, row));
      }
      case "DELETE /api/notes/delete":
        tombstone(noteCollection, body?.id);
        return {};
      case "DELETE /api/notes/delete-all": {
        let deleted = 0;
        for (const row of notes.values()) {
          if (row.deleted_at) continue;
          tombstone(noteCollection, row.id);
          deleted += 1;
        }
        return { deleted };
      }
      case "GET /api/notes/list":
        return { notes: page(noteCollection, query, "created_at") };
      case "POST /api/notes/search":
        return { notes: [] };

      case "POST /api/folders/create": {
        return upsertRow(folderCollection, body ?? {});
      }
      case "POST /api/folders/batch-create": {
        const inputs = Array.isArray(body?.folders) ? body.folders : [];
        const created = [];
        for (const input of inputs) {
          created.push(upsertRow(folderCollection, input));
        }
        return { created };
      }
      case "PATCH /api/folders/update": {
        const { id, ...updates } = body ?? {};
        const row = requireLive(folderCollection, id);
        return applyWrite(folderCollection, row, updates);
      }
      case "GET /api/me/spaces":
        if (spaces.size === 0 && !cfg.privateWorkspacePlacement)
          throw new HttpError(404, "fake cloud has no spaces route", "no_route");
        return {
          data: [...spaces.values()].map((space) => structuredClone(space)),
          ...(cfg.privateWorkspacePlacement
            ? {
                private_workspace_placement: true,
                default_workspace_id: cfg.defaultWorkspaceId ?? null,
              }
            : {}),
        };
      case "DELETE /api/folders/delete":
        tombstone(folderCollection, body?.id);
        return {};
      case "GET /api/folders/list": {
        const since = query.get("since");
        let rows = [...folders.values()];
        if (since) {
          const bound = normalizeTimestamp(since);
          rows = rows.filter((r) => normalizeTimestamp(r.updated_at) > bound);
        } else {
          rows = rows.filter((r) => !r.deleted_at);
        }
        rows.sort((a, b) => a.sort_order - b.sort_order || compare(a.id, b.id));
        return { folders: rows.map((row) => structuredClone(row)) };
      }

      // As api/conversations/create.ts: a client id already in the cloud keeps its
      // row, tombstone included, and every message in the request is inserted again.
      case "POST /api/conversations/create": {
        const existing = findByClientId(conversationCollection, body?.client_conversation_id);
        const row = existing ?? insertRow(conversationCollection, { ...body, messages: undefined });
        if (!existing) row.messages = [];
        row.title = body?.title ?? row.title;
        row.updated_at = toIso(body?.updated_at ?? clock());
        for (const message of body?.messages ?? []) appendConversationMessage(row, message);
        return conversationResponse(row);
      }
      case "PATCH /api/conversations/update": {
        const row = requireLiveConversation(body?.id);
        if (body?.title !== undefined && body.title !== null) row.title = body.title;
        row.updated_at = toIso(clock());
        return conversationResponse(row);
      }
      case "DELETE /api/conversations/delete": {
        const row = requireLiveConversation(body?.id);
        row.deleted_at = toIso(clock());
        row.updated_at = row.deleted_at;
        return {};
      }
      case "POST /api/conversations/messages": {
        const row = requireLiveConversation(body?.conversation_id);
        if (!body?.content) throw new HttpError(400, "content is required");
        const message = appendConversationMessage(row, body);
        row.updated_at = toIso(clock());
        return message;
      }
      case "GET /api/conversations/messages":
        return { messages: requireLiveConversation(query.get("conversation_id")).messages };
      case "GET /api/conversations/list": {
        const rows = page(conversationCollection, query, "created_at");
        // The client asks for include=messages; a page that stopped asking must
        // not silently keep receiving them.
        if (
          !String(query.get("include") ?? "")
            .split(",")
            .includes("messages")
        ) {
          for (const row of rows) delete row.messages;
        }
        return { conversations: rows };
      }
      case "POST /api/transcriptions/batch-create":
        return {
          created: (body?.transcriptions ?? []).map((t) => structuredClone(upsertTranscription(t))),
        };
      case "POST /api/transcriptions/create":
        return structuredClone(upsertTranscription(body ?? {}));
      // As the API: only rows it just deleted come back, so a retry gets none.
      case "POST /api/transcriptions/batch-delete":
        return {
          deleted: (body?.ids ?? []).filter((id) => {
            const row = transcriptions.get(id);
            if (!row || row.deleted_at) return false;
            tombstone(transcriptionCollection, id);
            return true;
          }),
        };
      case "DELETE /api/transcriptions/delete":
        return {};
      case "GET /api/transcriptions/list":
        return { transcriptions: page(transcriptionCollection, query, "created_at") };
      case "GET /api/dictionary/list":
        return dictionaryPage(query);
      case "DELETE /api/dictionary/delete":
        tombstone(dictionaryCollection, body?.id);
        return {};
      case "PATCH /api/dictionary/update": {
        const { id, ...updates } = body ?? {};
        return applyWrite(dictionaryCollection, requireLive(dictionaryCollection, id), updates);
      }
      case "POST /api/dictionary/batch-create": {
        const inputs = Array.isArray(body?.entries) ? body.entries : [];
        return {
          created: inputs.map((input) => upsertKeyedRow(dictionaryCollection, "word", input)),
        };
      }
      case "GET /api/snippets/list":
        return dictionaryPage(query, snippetCollection);
      case "PATCH /api/snippets/update": {
        const { id, ...updates } = body ?? {};
        return applyWrite(snippetCollection, requireLive(snippetCollection, id), updates);
      }
      case "DELETE /api/snippets/delete":
        tombstone(snippetCollection, body?.id);
        return {};
      case "POST /api/snippets/batch-create": {
        const inputs = Array.isArray(body?.entries) ? body.entries : [];
        return {
          created: inputs.map((input) => upsertKeyedRow(snippetCollection, "trigger", input)),
        };
      }
      default:
        throw new HttpError(404, `fake cloud has no route for ${route}`, "no_route");
    }
  }

  function toMatcher(matcher) {
    if (typeof matcher === "function") return matcher;
    const wanted = String(matcher);
    return (call) =>
      call.path.split("?")[0] === wanted || `${call.method} ${call.path.split("?")[0]}` === wanted;
  }

  function takeFailure(call) {
    const index = failures.findIndex((entry) => entry.matcher(call));
    if (index === -1) return null;
    const entry = failures[index];
    if (entry.once) failures.splice(index, 1);
    return entry.failure;
  }

  // An HTTP Date header carries whole seconds, so the client can only ever
  // learn the server clock to the second.
  function serverDateField() {
    return cfg.serverDate ? { serverDate: new Date(clock()).toUTCString() } : {};
  }

  async function request(opts) {
    const method = String(opts?.method ?? "GET").toUpperCase();
    const path = String(opts?.path ?? "");
    const body = structuredClone(opts?.body ?? null);
    const call = { method, path, body };
    // The log keeps its own copy so a handler can never rewrite history.
    log.push({ method, path, body: structuredClone(body) });

    const failure = takeFailure(call);
    if (failure) {
      return {
        success: false,
        error: failure.error ?? "fake cloud failure",
        status: failure.status ?? 500,
        code: failure.code,
      };
    }

    const [pathname, rawQuery] = path.split("?");
    try {
      const data = handle(method, pathname, new URLSearchParams(rawQuery ?? ""), body);
      return { success: true, data: structuredClone(data), ...serverDateField() };
    } catch (err) {
      if (err instanceof HttpError) {
        return {
          success: false,
          error: err.message,
          status: err.status,
          code: err.code,
          details: err.details,
          ...serverDateField(),
        };
      }
      throw err;
    }
  }

  return {
    request,
    log,
    logFor: (pathname) => log.filter((c) => c.path.split("?")[0] === pathname),
    failNext: (matcher, failure = {}) =>
      failures.push({ matcher: toMatcher(matcher), failure, once: true }),
    failWith: (matcher, failure = {}) =>
      failures.push({ matcher: toMatcher(matcher), failure, once: false }),
    clearFailures: () => failures.splice(0, failures.length),
    setClock: (fn) => {
      clock = fn;
    },
    seedNote: (input) => structuredClone(insertRow(noteCollection, input, { seeded: true })),
    // A teamspace the caller belongs to. With fileRowsHere, the notes and
    // folders a test seeds without a scope land in it (a client's unscoped
    // write stays personal); ownerId stamps user_id on notes, as the server
    // does.
    seedSpace: (space, options = {}) => {
      spaces.set(space.id, structuredClone(space));
      if (options.fileRowsHere) homeSpace = { id: space.id, workspace_id: space.workspace_id };
      if (options.ownerId !== undefined) ownerId = options.ownerId;
      return structuredClone(space);
    },
    removeSpace: (id) => spaces.delete(id),
    // A row the public API stored without a client id, and the server backfill
    // that later keys it by its own id without moving updated_at.
    seedUnkeyedNote: (input) => {
      const row = insertRow(noteCollection, input, { seeded: true });
      row.client_note_id = null;
      return structuredClone(row);
    },
    backfillNoteKey: (id) => {
      notes.get(id).client_note_id = id;
    },
    setNoteRevision: (id, revision) => {
      notes.get(id).revision = revision;
    },
    seedFolder: (input) => structuredClone(insertRow(folderCollection, input, { seeded: true })),
    seedConversation: (input = {}) => {
      const row = insertRow(conversationCollection, input);
      // The defaults object is spread, not cloned, so every row needs its own array.
      row.messages = structuredClone(input.messages ?? []);
      if (input.deleted_at) row.deleted_at = toIso(input.deleted_at);
      return structuredClone(row);
    },
    seedTranscription: (input) => structuredClone(insertRow(transcriptionCollection, input)),
    deleteTranscription: (id) => structuredClone(tombstone(transcriptionCollection, id)),
    deleteConversation: (id) => structuredClone(tombstone(conversationCollection, id)),
    deleteNote: (id) => structuredClone(tombstone(noteCollection, id)),
    seedDictionaryEntry: (input) => structuredClone(insertRow(dictionaryCollection, input)),
    seedSnippet: (input) => structuredClone(insertRow(snippetCollection, input)),
    dictionary: () => [...dictionary.values()].map((row) => structuredClone(row)),
    snippets: () => [...snippets.values()].map((row) => structuredClone(row)),
    notes: () => [...notes.values()].map((row) => structuredClone(row)),
    folders: () => [...folders.values()].map((row) => structuredClone(row)),
    conversations: () => [...conversations.values()].map((row) => structuredClone(row)),
    transcriptions: () => [...transcriptions.values()].map((row) => structuredClone(row)),
    note: (id) => {
      const row = notes.get(id) ?? findByClientId(noteCollection, id);
      return row ? structuredClone(row) : null;
    },
    folder: (id) => {
      const row = folders.get(id) ?? findByClientId(folderCollection, id);
      return row ? structuredClone(row) : null;
    },
    conversation: (id) => {
      const row = conversations.get(id) ?? findByClientId(conversationCollection, id);
      return row ? structuredClone(row) : null;
    },
    config: cfg,
  };
}

// One cloud per account. Real cloud ids are UUIDs, so two accounts' clouds
// never hold the same id; each of these mints its ids in a space of its own.
let accountClouds = 0;
function createAccountCloud(config = {}) {
  return createFakeCloud({ idSpace: `cloud${++accountClouds}-`, ...config });
}

module.exports = { createFakeCloud, createAccountCloud, normalizeTimestamp };
