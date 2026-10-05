// In-memory stand-in for the cloud API behind window.electronAPI.cloudApiRequest.
// Notes and folders are modelled with the hardened server's real write rules,
// conversations only on the read side; the other entity types exist only so a
// full syncAll() pass can complete.
//
// Each hardening rule sits behind its own flag so a test can flip the server
// back to the legacy behaviour and prove the client still does not lose data:
//   materialPatchGate  a PATCH that changes nothing does not bump updated_at
//   coalesceOnConflict an absent/null incoming field keeps the stored value
//   staleWriteGuard    a write whose basis predates the stored row is rejected
//   updatedAtClamp     a stored updated_at never moves backwards

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
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
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

// Conversations are read-only here: only the pull is modelled, so `messages`
// rides along as a plain stored field.
const CONVERSATION_FIELDS = ["title", "archived_at", "messages"];

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

function createFakeCloud(config = {}) {
  const cfg = {
    materialPatchGate: true,
    coalesceOnConflict: true,
    staleWriteGuard: true,
    updatedAtClamp: true,
    ...config,
  };

  const notes = new Map();
  const folders = new Map();
  const conversations = new Map();
  const log = [];
  const failures = [];
  let seq = 0;
  let clock = () => new Date().toISOString();

  const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, "0")}`;

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
    if (cfg.materialPatchGate && !material) return row;

    Object.assign(row, next);
    row.updated_at = bump(row, incoming.updated_at);
    return row;
  }

  function insertRow(collection, input) {
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
    collection.store.set(row.id, row);
    return row;
  }

  function findByClientId(collection, clientId) {
    if (!clientId) return null;
    for (const row of collection.store.values()) {
      if (row[collection.clientKey] === clientId) return row;
    }
    return null;
  }

  // batch-create is idempotent by client id: a retried batch must return the
  // existing row instead of forking a duplicate.
  function upsertRow(collection, input) {
    const existing = findByClientId(collection, input[collection.clientKey]);
    if (!existing) return insertRow(collection, input);
    if (existing.deleted_at) return existing;
    return applyWrite(collection, existing, input);
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
  };
  const folderCollection = {
    store: folders,
    fields: FOLDER_FIELDS,
    defaults: FOLDER_DEFAULTS,
    clientKey: "client_folder_id",
    prefix: "folder",
  };
  const conversationCollection = {
    store: conversations,
    fields: CONVERSATION_FIELDS,
    defaults: CONVERSATION_DEFAULTS,
    clientKey: "client_conversation_id",
    prefix: "conv",
  };

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

  function handle(method, pathname, query, body) {
    const route = `${method} ${pathname}`;
    switch (route) {
      case "POST /api/notes/create":
        return upsertRow(noteCollection, body ?? {});
      case "POST /api/notes/batch-create": {
        const inputs = Array.isArray(body?.notes) ? body.notes : [];
        return {
          created: inputs.map((input) => {
            const row = upsertRow(noteCollection, input);
            return { client_note_id: row.client_note_id, id: row.id };
          }),
        };
      }
      case "PATCH /api/notes/update": {
        const { id, ...updates } = body ?? {};
        return applyWrite(noteCollection, requireLive(noteCollection, id), updates);
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

      case "POST /api/folders/create":
        return upsertRow(folderCollection, body ?? {});
      case "POST /api/folders/batch-create": {
        const inputs = Array.isArray(body?.folders) ? body.folders : [];
        return { created: inputs.map((input) => upsertRow(folderCollection, input)) };
      }
      case "PATCH /api/folders/update": {
        const { id, ...updates } = body ?? {};
        return applyWrite(folderCollection, requireLive(folderCollection, id), updates);
      }
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

      // Conversation writes stay echo-stubs; only the read side is modelled,
      // because the pull is what has to survive the ISO/SQLite format skew.
      case "POST /api/conversations/create":
        return { ...body, id: nextId("conv") };
      case "PATCH /api/conversations/update":
        return { ...body };
      case "DELETE /api/conversations/delete":
        return {};
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
          created: (body?.transcriptions ?? []).map((t) => ({ ...t, id: nextId("trans") })),
        };
      case "POST /api/transcriptions/create":
        return { ...body, id: nextId("trans") };
      case "POST /api/transcriptions/batch-delete":
        return { deleted: body?.ids ?? [] };
      case "DELETE /api/transcriptions/delete":
        return {};
      case "GET /api/transcriptions/list":
        return { transcriptions: [] };
      case "GET /api/dictionary/list":
        return { entries: [], hasMore: false };
      case "POST /api/dictionary/batch-create":
        return { created: [] };
      case "GET /api/snippets/list":
        return { entries: [], hasMore: false };
      case "POST /api/snippets/batch-create":
        return { created: [] };
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
      return { success: true, data: structuredClone(data) };
    } catch (err) {
      if (err instanceof HttpError) {
        return { success: false, error: err.message, status: err.status, code: err.code };
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
    seedNote: (input) => structuredClone(insertRow(noteCollection, input)),
    seedFolder: (input) => structuredClone(insertRow(folderCollection, input)),
    // Conversation deletes are echo-stubs, so a tombstone has to be seeded here
    // rather than produced by the DELETE route.
    seedConversation: (input = {}) => {
      const row = insertRow(conversationCollection, input);
      // The defaults object is spread, not cloned, so every row needs its own array.
      row.messages = structuredClone(input.messages ?? []);
      if (input.deleted_at) row.deleted_at = toIso(input.deleted_at);
      return structuredClone(row);
    },
    notes: () => [...notes.values()].map((row) => structuredClone(row)),
    folders: () => [...folders.values()].map((row) => structuredClone(row)),
    conversations: () => [...conversations.values()].map((row) => structuredClone(row)),
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

module.exports = { createFakeCloud, normalizeTimestamp };
