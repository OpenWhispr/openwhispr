import type { NoteScope } from "./noteScope";
import type { SpaceItem } from "../../types/electron";
import type { ContainerScope } from "../../types/chat";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./ToolRegistry";
import { resolveLocalNoteId, resolveSpace } from "./utils";
import { withoutAttendeesFence } from "../../utils/noteAttendees";
import { getValidatedAuthGeneration } from "../../lib/authRequestContext";

export const MAX_CONTENT_LENGTH = 500;

// The most the cloud search endpoint returns at once; it refuses a larger limit.
const MAX_SEARCH_LIMIT = 50;
// Bound concurrent requests while keeping every request scoped on the server.
const MAX_CLOUD_SPACE_REQUESTS = 10;
const CANCELLED_SEARCH: ToolResult = { success: false, data: null, displayText: "" };

interface SearchToolOptions {
  useCloudSearch: boolean;
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
      // Capture before local reads: a delayed cloud fallback belongs to this sign-in too.
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

      // Fallback chain: local semantic (hybrid RRF) → FTS5 keyword → cloud. Everything in scope
      // is on this device, so the cloud is asked only when nothing local matched, and only for
      // teamspaces: private notes never leave the device, and the personal rows the cloud may
      // still hold are stale copies of them. Folder scoping is local-only: the cloud API has no
      // folder filter.
      const cloudSpaces = spaces.filter(
        (s) => s.kind === "team" && !!s.cloud_space_id && searchSpaceIds.includes(s.id)
      );
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
      if (useCloudSearch && cloudSpaces.length > 0 && folderId == null) {
        strategies.push(() =>
          executeCloudSearch(
            query,
            limit,
            space,
            cloudSpaces,
            searchSpaceIds,
            authGeneration,
            isCurrent
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
  cloudSpaces: SpaceItem[],
  spaceIds: number[],
  authGeneration: number | null,
  isCurrent: () => boolean
): Promise<ToolResult> {
  if (authGeneration == null) throw new Error("Cloud note search requires a verified account");
  const { NotesService } = await import("../../services/NotesService.js");
  const cloudIds = cloudSpaces.flatMap((s) => (s.cloud_space_id ? [s.cloud_space_id] : []));
  const spaceByCloudId = new Map(cloudSpaces.map((s) => [s.cloud_space_id, s]));
  // Membership is server-enforced; one request per teamspace keeps personal rows out entirely.
  const answers: PromiseSettledResult<Awaited<ReturnType<typeof NotesService.search>>>[] = [];
  for (let offset = 0; offset < cloudIds.length; offset += MAX_CLOUD_SPACE_REQUESTS) {
    if (!isCurrent()) return CANCELLED_SEARCH;
    const batch = cloudIds.slice(offset, offset + MAX_CLOUD_SPACE_REQUESTS);
    answers.push(
      ...(await Promise.allSettled(
        batch.map((cloudId) =>
          NotesService.search(query, limit, undefined, cloudId, authGeneration)
        )
      ))
    );
    if (!isCurrent()) return CANCELLED_SEARCH;
  }
  const answered = answers.flatMap((answer) =>
    answer.status === "fulfilled" ? [answer.value.notes] : []
  );
  // A teamspace whose request failed is left out; the search fails only when every one did.
  if (answered.length === 0) {
    throw answers.find((answer): answer is PromiseRejectedResult => answer.status === "rejected")
      ?.reason;
  }
  // A personal row (no space) is a stale cloud copy of a private note, and a space this device
  // doesn't hold in scope is another workspace's: neither reaches the model, whatever a request
  // returned.
  const inScope = answered
    .flat()
    .flatMap((cn) => {
      const local = cn.space_id ? spaceByCloudId.get(cn.space_id) : undefined;
      return local ? [{ cn, spaceName: local.name }] : [];
    })
    .sort((a, b) => b.cn.score - a.cn.score)
    .slice(0, limit);

  const results = await Promise.all(
    inScope.map(async ({ cn, spaceName }) => ({
      id: await resolveLocalNoteId(cn.client_note_id ?? cn.id, async () => {
        if (!isCurrent()) return null;
        const local =
          (await window.electronAPI.getNoteForCloudRow?.(cn.client_note_id, cn.id)) ?? null;
        // The local copy may have moved out of scope since: no id leads to it.
        return isCurrent() && local && spaceIds.includes(local.space_id) ? local : null;
      }),
      title: cn.title && withoutAttendeesFence(cn.title),
      date: cn.created_at,
      type: cn.note_type,
      score: cn.score,
      space: spaceName,
      content: withoutAttendeesFence(
        (cn.enhanced_content || cn.content).slice(0, MAX_CONTENT_LENGTH)
      ),
    }))
  );

  if (!isCurrent()) return CANCELLED_SEARCH;
  return {
    success: true,
    data: results,
    displayText: summaryText(results.length, query, space, true),
  };
}
