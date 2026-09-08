import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "electron";
import {
  CreateFolderRequestSchema,
  CreateNoteRequestSchema,
  FolderSchema,
  ListNotesQuerySchema,
  ListTranscriptionsQuerySchema,
  NoteSchema,
  NoteSearchResultSchema,
  SearchNotesRequestSchema,
  TranscriptSegmentSchema,
  TranscriptionFormatSchema,
  TranscriptionSchema,
  UpdateNoteRequestSchema,
  type ApiKeyScope,
} from "../../src/config/openwhisprApi.ts";
import { broadcastToWindows } from "../../src/helpers/windowBroadcast.js";
import { OppulenceAPIKeyVerifier } from "./apiKeyVerifier.ts";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PUBLIC_ID = /^00000000-0000-4000-8000-([a-f0-9]{12})$/i;
const NO_CONTENT = Symbol("OppulencePublicAPI.NoContent");

type LocalRow = Record<string, unknown>;

interface MutationResult extends LocalRow {
  success?: boolean;
  error?: string;
  note?: LocalRow;
  folder?: LocalRow;
}

interface DatabaseManager {
  getNotes(noteType: string | null, limit: number, folderID: number | null): LocalRow[];
  searchNotes(query: string, limit: number): LocalRow[];
  getNote(id: number): LocalRow | null;
  saveNote(
    title: string,
    content: string,
    noteType: string,
    sourceFile: null,
    audioDurationSeconds: null,
    folderID: number | null,
    spaceID: number | null
  ): MutationResult;
  updateNote(id: number, updates: LocalRow): MutationResult;
  getFolders(): LocalRow[];
  createFolder(name: string, spaceID: number | null): MutationResult;
  getTranscriptions(limit: number): LocalRow[];
  getTranscriptionById(id: number): LocalRow | null;
}

interface IPCHandlers {
  databaseManager: DatabaseManager;
  _asyncVectorUpsert(note: LocalRow): void;
  _asyncMirrorWrite(note: LocalRow): void;
  deleteNoteInternal(id: number): MutationResult;
  deleteTranscriptionInternal(id: number): MutationResult;
}

interface TokenStore {
  get(): string | null;
}

interface Logger {
  error?(message: string, details?: Record<string, unknown>, scope?: string): void;
  warn?(message: string, details?: Record<string, unknown>): void;
}

interface PublicAPIContext {
  app: App;
  apiURL: string;
  ipcHandlers: IPCHandlers;
  logger: Logger;
  tokenStore: TokenStore;
  verifier?: APIKeyAuthorizer;
}

interface APIKeyAuthorizer {
  authorize(secret: string, requiredScope: ApiKeyScope): Promise<boolean>;
}

interface RouteContext {
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
}

interface Route {
  method: string;
  match(pathname: string): Record<string, string> | null;
  handler(context: RouteContext): unknown | Promise<unknown>;
  status?: number;
}

interface TextResult {
  text: string;
}

class PublicAPIError extends Error {
  // Written out longhand rather than as constructor parameter properties:
  // Electron's main process loads this file through Node's strip-only
  // TypeScript support, which rejects that syntax outright.
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJSON(res, status, { error: { code, message } });
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer | string) => {
      raw += chunk.toString();
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        reject(new PublicAPIError(413, "payload_too_large", "Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new PublicAPIError(400, "validation_error", "Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function parseID(value: unknown): number {
  const text = String(value);
  const match = text.match(PUBLIC_ID);
  const id = match ? Number.parseInt(match[1], 16) : Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PublicAPIError(404, "not_found", "Resource not found");
  }
  return id;
}

function publicID(value: unknown): string {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffffffff) {
    throw new PublicAPIError(500, "internal_error", "Local identifier is not API-safe");
  }
  return `00000000-0000-4000-8000-${id.toString(16).padStart(12, "0")}`;
}

function apiDate(value: unknown): string {
  return new Date(
    typeof value === "string" || typeof value === "number" ? value : Date.now()
  ).toISOString();
}

function parseSegments(value: unknown): LocalRow[] | null {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "null") as LocalRow | null;
    const result = TranscriptSegmentSchema.array().safeParse(parsed?.segments);
    return result.success ? (result.data as LocalRow[]) : null;
  } catch {
    return null;
  }
}

function publicNote(note: LocalRow, score?: unknown): LocalRow {
  const value = NoteSchema.parse({
    id: publicID(note.id),
    user_id: "local",
    client_note_id: note.client_note_id ?? null,
    title: note.title ?? null,
    content: note.content ?? "",
    enhanced_content: note.enhanced_content ?? null,
    note_type: ["personal", "meeting", "upload"].includes(String(note.note_type))
      ? note.note_type
      : "personal",
    folder_id: note.folder_id == null ? null : publicID(note.folder_id),
    participants: note.participants ?? null,
    calendar_event_id: note.calendar_event_id ?? null,
    created_at: apiDate(note.created_at),
    updated_at: apiDate(note.updated_at),
  });
  return score === undefined
    ? value
    : NoteSearchResultSchema.parse({ ...value, score: Number(score) || 0 });
}

function publicFolder(folder: LocalRow): LocalRow {
  return FolderSchema.parse({
    id: publicID(folder.id),
    user_id: "local",
    name: folder.name,
    is_default: Boolean(folder.is_default),
    sort_order: Number(folder.sort_order) || 0,
    created_at: apiDate(folder.created_at),
    updated_at: apiDate(folder.updated_at),
  });
}

function publicTranscription(transcription: LocalRow): LocalRow {
  const text = String(transcription.text || "");
  return TranscriptionSchema.parse({
    id: publicID(transcription.id),
    user_id: "local",
    text,
    word_count: Number(transcription.word_count) || text.trim().split(/\s+/).filter(Boolean).length,
    source: transcription.source === "cloud" ? "cloud" : "local",
    provider: transcription.provider ?? null,
    model: transcription.model ?? null,
    language: transcription.language ?? null,
    audio_duration_ms: transcription.audio_duration_ms ?? null,
    processing_ms: transcription.processing_ms ?? null,
    segments: parseSegments(transcription.raw_text),
    created_at: apiDate(transcription.created_at),
  });
}

function subtitleTimestamp(seconds: unknown, separator: string): string {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const milliseconds = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function subtitleText(segments: unknown, format: "srt" | "vtt"): string {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new PublicAPIError(
      400,
      "validation_error",
      "Subtitle output requires timestamped segments"
    );
  }
  const blocks = (segments as LocalRow[]).map((segment, index) => {
    const separator = format === "srt" ? "," : ".";
    const cue = `${subtitleTimestamp(segment.start, separator)} --> ${subtitleTimestamp(segment.end, separator)}\n${segment.speaker ? `${String(segment.speaker)}: ` : ""}${String(segment.text || "")}`;
    return format === "srt" ? `${index + 1}\n${cue}` : cue;
  });
  return format === "vtt" ? `WEBVTT\n\n${blocks.join("\n\n")}\n` : `${blocks.join("\n\n")}\n`;
}

function unwrapMutation(result: MutationResult, field: "note" | "folder"): LocalRow {
  if (!result?.success || !result[field]) {
    throw new PublicAPIError(500, "write_failed", result?.error || `Failed to write ${field}`);
  }
  return result[field];
}

function requireSuccess(result: MutationResult, message: string): void {
  if (!result?.success) throw new PublicAPIError(404, "not_found", result?.error || message);
}

function isTextResult(value: unknown): value is TextResult {
  return Boolean(value && typeof value === "object" && "text" in value);
}

export class OppulencePublicAPI {
  private readonly db: DatabaseManager;
  private readonly ipc: IPCHandlers;
  private readonly logger: Logger;
  private readonly verifier: APIKeyAuthorizer;
  private readonly routes: Route[];

  constructor({ app, apiURL, ipcHandlers, logger, tokenStore, verifier }: PublicAPIContext) {
    this.db = ipcHandlers.databaseManager;
    this.ipc = ipcHandlers;
    this.logger = logger;
    this.verifier = verifier ?? new OppulenceAPIKeyVerifier(app, apiURL, tokenStore, logger);
    this.routes = this.buildRoutes();
  }

  canHandle(pathname: string): boolean {
    return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      this.validateLoopbackHeaders(req);
      const pathname = url.pathname.slice(4);
      const route = this.matchRoute(req.method || "", pathname);
      if (!route) throw new PublicAPIError(404, "not_found", "Not found");

      const authorization = String(req.headers.authorization || "");
      const secret = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (
        !(await this.verifier.authorize(secret, this.requiredScope(req.method || "", pathname)))
      ) {
        throw new PublicAPIError(401, "unauthorized", "Unauthorized");
      }

      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJSON(req);
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        res.writeHead(204);
        res.end();
      } else if (isTextResult(result)) {
        sendText(res, route.status || 200, result.text);
      } else {
        sendJSON(res, route.status || 200, result);
      }
    } catch (error) {
      if (error instanceof PublicAPIError) {
        sendError(res, error.status, error.code, error.message);
      } else if (error instanceof Error && error.name === "ZodError") {
        sendError(res, 400, "validation_error", "Request did not match the API contract");
      } else {
        this.logger.error?.(
          "Oppulence public API route error",
          { error: error instanceof Error ? error.message : String(error) },
          "oppulence-public-api"
        );
        sendError(res, 500, "internal_error", "Internal server error");
      }
    }
  }

  private validateLoopbackHeaders(req: IncomingMessage): void {
    const hostHeader = String(req.headers.host || "");
    const host = hostHeader.startsWith("[")
      ? `${hostHeader.split("]")[0]}]`
      : hostHeader.split(":")[0];
    if (!LOOPBACK_HOSTS.has(host)) throw new PublicAPIError(403, "forbidden", "Forbidden");
    if (!req.headers.origin) return;
    try {
      if (!LOOPBACK_HOSTS.has(new URL(req.headers.origin).hostname)) throw new Error();
    } catch {
      throw new PublicAPIError(403, "forbidden", "Forbidden");
    }
  }

  private requiredScope(method: string, pathname: string): ApiKeyScope {
    if (pathname.startsWith("/v1/transcriptions")) {
      return method === "DELETE" ? "transcriptions:delete" : "transcriptions:read";
    }
    if (pathname === "/v1/usage") return "usage:read";
    return method === "GET" ? "notes:read" : "notes:write";
  }

  private matchRoute(
    method: string,
    pathname: string
  ): (Route & { params: Record<string, string> }) | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  private buildRoutes(): Route[] {
    const exact = (
      method: string,
      path: string,
      handler: Route["handler"],
      status?: number
    ): Route => ({ method, match: (value) => (value === path ? {} : null), handler, status });
    const param = (
      method: string,
      prefix: string,
      suffix: string,
      handler: Route["handler"]
    ): Route => ({
      method,
      match: (value) => {
        if (!value.startsWith(prefix)) return null;
        const rest = value.slice(prefix.length);
        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const id = rest.slice(0, -suffix.length);
          return id && !id.includes("/") ? { id } : null;
        }
        return rest && !rest.includes("/") ? { id: rest } : null;
      },
      handler,
    });

    return [
      exact("GET", "/v1/notes/list", ({ query }) => {
        const input = ListNotesQuerySchema.parse(Object.fromEntries(query));
        const folderID = input.folder_id ? parseID(input.folder_id) : null;
        return {
          data: this.db.getNotes(null, input.limit, folderID).map((note) => publicNote(note)),
          has_more: false,
          next_cursor: null,
        };
      }),
      exact("POST", "/v1/notes/search", ({ body }) => {
        const input = SearchNotesRequestSchema.parse(body);
        return {
          data: this.db
            .searchNotes(input.query, input.limit)
            .map((note) => publicNote(note, note.score)),
        };
      }),
      param("GET", "/v1/notes/", "/transcript", ({ params }) => {
        const id = parseID(params.id);
        const note = this.db.getNote(id);
        if (!note || note.deleted_at || !note.transcript) {
          throw new PublicAPIError(404, "not_found", `Note ${params.id} has no transcript`);
        }
        const segments = parseSegments(note.transcript);
        const text = segments
          ? segments
              .map((segment) => String(segment.text || ""))
              .join(" ")
              .trim()
          : String(note.transcript);
        return {
          data: {
            note_id: publicID(id),
            transcription_id: null,
            text,
            word_count: text.split(/\s+/).filter(Boolean).length,
            language: null,
            duration_ms: note.audio_duration_seconds
              ? Number(note.audio_duration_seconds) * 1000
              : null,
            provider: null,
            model: null,
            segments,
            created_at: apiDate(note.created_at),
          },
        };
      }),
      param("GET", "/v1/notes/", "", ({ params }) => {
        const note = this.db.getNote(parseID(params.id));
        if (!note || note.deleted_at) {
          throw new PublicAPIError(404, "not_found", `Note ${params.id} not found`);
        }
        return { data: publicNote(note) };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const input = CreateNoteRequestSchema.parse(body);
          let note = unwrapMutation(
            this.db.saveNote(
              input.title ?? "Untitled Note",
              input.content ?? "",
              input.note_type ?? "personal",
              null,
              null,
              input.folder_id == null ? null : parseID(input.folder_id),
              input.space_id == null ? null : parseID(input.space_id)
            ),
            "note"
          );
          if (input.enhanced_content !== undefined) {
            note = unwrapMutation(
              this.db.updateNote(Number(note.id), { enhanced_content: input.enhanced_content }),
              "note"
            );
          }
          setImmediate(() => broadcastToWindows("note-added", note));
          this.ipc._asyncVectorUpsert(note);
          this.ipc._asyncMirrorWrite(note);
          return { data: publicNote(note) };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", ({ params, body }) => {
        const input = UpdateNoteRequestSchema.parse(body);
        const updates: LocalRow = {
          ...input,
          ...(input.folder_id === undefined
            ? {}
            : { folder_id: input.folder_id === null ? null : parseID(input.folder_id) }),
        };
        const note = unwrapMutation(this.db.updateNote(parseID(params.id), updates), "note");
        setImmediate(() => broadcastToWindows("note-updated", note));
        this.ipc._asyncVectorUpsert(note);
        this.ipc._asyncMirrorWrite(note);
        return { data: publicNote(note) };
      }),
      param("DELETE", "/v1/notes/", "", ({ params }) => {
        requireSuccess(
          this.ipc.deleteNoteInternal(parseID(params.id)),
          `Note ${params.id} not found`
        );
        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => ({
        data: this.db.getFolders().map(publicFolder),
        has_more: false,
        next_cursor: null,
      })),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const input = CreateFolderRequestSchema.parse(body);
          const folder = unwrapMutation(
            this.db.createFolder(
              input.name,
              input.space_id == null ? null : parseID(input.space_id)
            ),
            "folder"
          );
          setImmediate(() => broadcastToWindows("folder-created", folder));
          return { data: publicFolder(folder) };
        },
        201
      ),
      exact("GET", "/v1/usage", () => {
        const used = this.db
          .getTranscriptions(10_000)
          .reduce((total, row) => total + (Number(row.word_count) || 0), 0);
        const limit = 2_147_483_647;
        return {
          data: {
            words_used: used,
            limit,
            words_remaining: Math.max(0, limit - used),
            plan: "free",
            is_subscribed: false,
            billing_interval: "local-unlimited",
            current_period_end: "9999-12-31T23:59:59Z",
          },
        };
      }),
      exact("GET", "/v1/spaces/list", () => {
        throw new PublicAPIError(
          403,
          "workspace_key_required",
          "Oppulence personal API keys do not address team spaces"
        );
      }),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const input = ListTranscriptionsQuerySchema.parse(Object.fromEntries(query));
        const noteID = input.note_id ? parseID(input.note_id) : null;
        const rows = this.db
          .getTranscriptions(10_000)
          .filter(
            (row) =>
              (noteID === null || Number(row.note_id) === noteID) &&
              (!input.language || row.language === input.language)
          )
          .slice(0, input.limit);
        return {
          data: rows.map(publicTranscription),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", ({ params, query }) => {
        const transcription = this.db.getTranscriptionById(parseID(params.id));
        if (!transcription || transcription.deleted_at) {
          throw new PublicAPIError(404, "not_found", `Transcription ${params.id} not found`);
        }
        const value = publicTranscription(transcription);
        const format = TranscriptionFormatSchema.parse(query.get("format") || "json");
        if (format === "json") return { data: value };
        if (format === "text") return { text: String(value.text || "") };
        return { text: subtitleText(value.segments, format) };
      }),
      param("DELETE", "/v1/transcriptions/", "", ({ params }) => {
        requireSuccess(
          this.ipc.deleteTranscriptionInternal(parseID(params.id)),
          `Transcription ${params.id} not found`
        );
        return NO_CONTENT;
      }),
    ];
  }
}
