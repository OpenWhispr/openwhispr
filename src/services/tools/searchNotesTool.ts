import type { NoteSearchScope } from "../NotesService";
import type { NoteScope } from "./noteScope";
import type { NoteItem, SpaceItem } from "../../types/electron";
import type { ContainerScope } from "../../types/chat";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./ToolRegistry";
import { resolveLocalNoteId, resolveSpace } from "./utils";
import { withoutAttendeesFence } from "../../utils/noteAttendees";
import { getValidatedAuthGeneration } from "../../lib/authRequestContext";

export const MAX_CONTENT_LENGTH = 500;

// The most the cloud search endpoint returns at once; it refuses a larger limit.
const MAX_SEARCH_LIMIT = 50;
const CANCELLED_SEARCH: ToolResult = { success: false, data: null, displayText: "" };

interface SearchToolOptions {
  useCloudSearch: boolean;
  privateWorkspaceId?: string | null;
  protectNotes?: NoteScope["protectNotes"];
  /** Pins every search to this container; the LLM's space arg is dropped. */
  fixedScope?: ContainerScope;
  /**
   * The spaces search reads: the active workspace's Private and its teamspaces in scope. A note
   * anywhere else never reaches the model, whatever the space arg names.
   */
  scopeSpaceIds: readonly number[];
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { useCloudSearch, fixedScope } = options;
  const scopeSpaceIds = new Set(options.scopeSpaceIds);

  const spaceParameter = fixedScope
    ? {}
    : {
        space: {
          type: "string",
          description: "Space name to search within. Omit to search all accessible spaces.",
        },
      };

  return {
    name: "search_notes",
    description: fixedScope
      ? "Search the notes in the folder or space the user is currently viewing, using semantic search. Understands meaning and context, not just keywords. Returns matching notes with title, date, relevance score, space, and a preview of content."
      : "Search the user's notes using semantic search. Understands meaning and context, not just keywords. Searches every space the user can access by default; pass space to search within a single space. Returns matching notes with title, date, relevance score, space, and a preview of content.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A few topic keywords, not the full question. For questions about plan costs or prices, search for pricing.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
        ...spaceParameter,
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(
      args: Record<string, unknown>,
      context?: ToolExecutionContext
    ): Promise<ToolResult> {
      // Capture before local reads: every search belongs to this sign-in.
      const authGeneration = getValidatedAuthGeneration();
      const isCurrent = (): boolean =>
        !context?.signal.aborted && getValidatedAuthGeneration() === authGeneration;
      if (!isCurrent()) return CANCELLED_SEARCH;
      const query = args.query as string;
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_SEARCH_LIMIT)
          : 5;
      const spaceName = fixedScope ? undefined : (args.space as string | undefined);

      // Only spaces in scope can be named, listed or searched.
      const spaces = ((await window.electronAPI.getSpaces?.()) ?? []).filter((s) =>
        scopeSpaceIds.has(s.id)
      );
      if (!isCurrent()) return CANCELLED_SEARCH;
      let space: SpaceItem | undefined;
      if (fixedScope) {
        space = spaces.find((s) => s.id === fixedScope.spaceId);
      } else if (spaceName) {
        const resolved = resolveSpace(spaces, spaceName);
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        space = resolved.space;
      }
      const searchSpaceIds = spacesToSearch(space, spaces, scopeSpaceIds, !!fixedScope);
      const folderId = fixedScope?.folderId ?? null;

      const searchSpaces = spaces.filter((candidate) => searchSpaceIds.includes(candidate.id));
      const privateSpaces = searchSpaces.filter((candidate) => candidate.kind === "private");
      const privateWorkspaceId = privateSpaces.length
        ? (options.privateWorkspaceId ??
          privateSpaces.find((candidate) => candidate.workspace_id)?.workspace_id ??
          null)
        : null;
      const cloudScope = {
        spaceIds: searchSpaces.flatMap((candidate) =>
          candidate.kind === "team" && candidate.cloud_space_id ? [candidate.cloud_space_id] : []
        ),
        privateWorkspaceId,
      };
      // Keep main's cloud → semantic → keyword order. Folder filtering remains local-only.
      const strategies: Array<() => Promise<ToolResult>> = [
        () =>
          executeLocalSearch(
            query,
            limit,
            true,
            space,
            spaces,
            searchSpaceIds,
            folderId,
            isCurrent,
            options.protectNotes
          ),
        () =>
          executeLocalSearch(
            query,
            limit,
            false,
            space,
            spaces,
            searchSpaceIds,
            folderId,
            isCurrent,
            options.protectNotes
          ),
      ];
      if (
        useCloudSearch &&
        (cloudScope.spaceIds.length || privateWorkspaceId) &&
        folderId == null
      ) {
        strategies.unshift(() =>
          executeCloudSearch(
            query,
            limit,
            space,
            searchSpaces,
            cloudScope,
            authGeneration,
            isCurrent,
            options.protectNotes
          )
        );
      }

      for (let i = 0; i < strategies.length; i++) {
        if (!isCurrent()) return CANCELLED_SEARCH;
        try {
          const result = await strategies[i]();
          if (!isCurrent()) return CANCELLED_SEARCH;
          if (Array.isArray(result.data) && result.data.length === 0 && i < strategies.length - 1)
            continue;
          return result;
        } catch (error) {
          if (!isCurrent()) return CANCELLED_SEARCH;
          if (i === strategies.length - 1) {
            return {
              success: false,
              data: null,
              displayText: `Failed to search notes: ${(error as Error).message}`,
            };
          }
        }
      }

      return { success: false, data: null, displayText: "No search strategies available" };
    },
  };
}

// The spaces one search reads. Private stands for every Private in scope, as the tree's section
// does (the pending one too, until main binds it). A pinned container outside the scope reads
// nothing.
function spacesToSearch(
  space: SpaceItem | undefined,
  spaces: SpaceItem[],
  scopeSpaceIds: ReadonlySet<number>,
  pinned: boolean
): number[] {
  if (!space) return pinned ? [] : [...scopeSpaceIds];
  if (space.kind === "private" && !pinned) {
    return spaces.filter((s) => s.kind === "private").map((s) => s.id);
  }
  return [space.id];
}

function summaryText(
  count: number,
  query: string,
  space: SpaceItem | undefined,
  semantic: boolean
): string {
  const scope = space ? ` in ${space.name}` : "";
  if (count === 0) return `No notes found for "${query}"${scope}`;
  return `Found ${count} note${count === 1 ? "" : "s"} for "${query}"${scope}${semantic ? " (semantic search)" : ""}`;
}

async function executeLocalSearch(
  query: string,
  limit: number,
  semantic: boolean,
  space: SpaceItem | undefined,
  spaces: SpaceItem[],
  spaceIds: number[],
  folderId: number | null,
  isCurrent: () => boolean,
  protectNotes?: NoteScope["protectNotes"]
): Promise<ToolResult> {
  const notes = semantic
    ? await window.electronAPI.semanticSearchNotes(query, limit, null, folderId, spaceIds)
    : await window.electronAPI.searchNotes(query, limit, null, folderId, spaceIds);

  if (!isCurrent()) return CANCELLED_SEARCH;
  const spaceNameById = new Map(spaces.map((s) => [s.id, s.name]));
  // Main already searched these spaces only; a note it returns from anywhere else is dropped.
  const inScope = notes.filter((note) => spaceIds.includes(note.space_id));
  await protectNotes?.(inScope);
  if (!isCurrent()) return CANCELLED_SEARCH;
  const results = inScope.map((note) => ({
    id: note.id,
    title: withoutAttendeesFence(note.title),
    date: note.created_at,
    type: note.note_type,
    space: spaceNameById.get(note.space_id) ?? null,
    content: withoutAttendeesFence(
      (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH)
    ),
  }));

  return {
    success: true,
    data: results,
    displayText: summaryText(results.length, query, space, semantic),
  };
}

async function executeCloudSearch(
  query: string,
  limit: number,
  space: SpaceItem | undefined,
  spaces: SpaceItem[],
  cloudScope: NoteSearchScope,
  authGeneration: number | null,
  isCurrent: () => boolean,
  protectNotes?: NoteScope["protectNotes"]
): Promise<ToolResult> {
  if (authGeneration == null) throw new Error("Cloud note search requires a verified account");
  const { NotesService } = await import("../../services/NotesService.js");
  if (!isCurrent()) return CANCELLED_SEARCH;
  const { notes } = await NotesService.search(
    query,
    limit,
    "all",
    undefined,
    authGeneration,
    cloudScope
  );
  if (!isCurrent()) return CANCELLED_SEARCH;
  const teamByCloudId = new Map(
    spaces
      .filter((candidate) => candidate.kind === "team")
      .map((candidate) => [candidate.cloud_space_id, candidate])
  );
  const privateSpaces = spaces.filter((candidate) => candidate.kind === "private");
  const privateIds = new Set(privateSpaces.map((candidate) => candidate.id));
  const spaceIds = new Set(spaces.map((candidate) => candidate.id));
  const localNotes: NoteItem[] = [];
  let containsPrivate = false;
  const results = [];

  // The server scopes before ranking. Keep that ranking and check scope again before exposure.
  for (const cloudNote of notes) {
    const team = cloudNote.space_id ? teamByCloudId.get(cloudNote.space_id) : undefined;
    const isPrivate =
      !cloudNote.space_id && !cloudNote.workspace_id && !!cloudScope.privateWorkspaceId;
    if (!team && !isPrivate) continue;
    if (
      isPrivate &&
      cloudNote.private_workspace_id != null &&
      cloudNote.private_workspace_id !== cloudScope.privateWorkspaceId
    )
      continue;
    let local: NoteItem | null = null;
    try {
      local =
        (await window.electronAPI.getNoteForCloudRow?.(cloudNote.client_note_id, cloudNote.id)) ??
        null;
    } catch {
      // Cloud-only results remain useful without a local card; Private still protects the chat.
    }
    if (!isCurrent()) return CANCELLED_SEARCH;
    if (isPrivate) {
      // Legacy NULL placement belongs to the default; a known local move is stronger evidence.
      if (local && !privateIds.has(local.space_id)) continue;
      if (
        cloudNote.private_workspace_id == null &&
        !local &&
        !privateSpaces.some((candidate) => candidate.is_default_private === 1)
      )
        continue;
      containsPrivate = true;
    }
    const linked = local && spaceIds.has(local.space_id) && !local.deleted_at ? local : null;
    if (linked) localNotes.push(linked);
    results.push({
      id: await resolveLocalNoteId(cloudNote.client_note_id ?? cloudNote.id, async () => linked),
      title: cloudNote.title && withoutAttendeesFence(cloudNote.title),
      date: cloudNote.created_at,
      type: cloudNote.note_type,
      score: cloudNote.score,
      space: team?.name ?? privateSpaces[0]?.name ?? null,
      content: withoutAttendeesFence(
        (cloudNote.enhanced_content || cloudNote.content).slice(0, MAX_CONTENT_LENGTH)
      ),
    });
    if (results.length === limit) break;
  }
  // A cloud-only Private hit has no local id for main to inspect. Protect it explicitly.
  await protectNotes?.(localNotes, containsPrivate);
  if (!isCurrent()) return CANCELLED_SEARCH;
  return {
    success: true,
    data: results,
    displayText: summaryText(results.length, query, space, true),
  };
}
