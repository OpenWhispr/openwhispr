import type { SpaceItem } from "../../types/electron";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveSpace } from "./utils";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  useCloudSearch: boolean;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { useCloudSearch } = options;

  return {
    name: "search_notes",
    description:
      "Search the user's notes using semantic search. Understands meaning and context, not just keywords. Searches every space the user can access by default; pass space to search within a single space. Returns matching notes with title, date, relevance score, space, and a preview of content.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant notes",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default 5)",
        },
        space: {
          type: "string",
          description: "Space name to search within. Omit to search all accessible spaces.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const spaceName = args.space as string | undefined;

      const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
      let space: SpaceItem | undefined;
      if (spaceName) {
        const resolved = resolveSpace(spaces, spaceName);
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        space = resolved.space;
      }

      // Fallback chain: cloud → local semantic (hybrid RRF) → FTS5 keyword.
      // A team space without a cloud team can't be scoped server-side, so its
      // searches go straight to the local legs.
      const strategies: Array<() => Promise<ToolResult>> = [];
      const cloudCanScope = !space || space.kind === "private" || !!space.cloud_team_id;
      if (useCloudSearch && cloudCanScope) {
        strategies.push(() => executeCloudSearch(query, limit, space, spaces));
      }
      strategies.push(() => executeLocalSearch(query, limit, true, space, spaces));
      strategies.push(() => executeLocalSearch(query, limit, false, space, spaces));

      for (let i = 0; i < strategies.length; i++) {
        try {
          return await strategies[i]();
        } catch (error) {
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
  spaces: SpaceItem[]
): Promise<ToolResult> {
  const spaceId = space?.id ?? null;
  const notes = semantic
    ? await window.electronAPI.semanticSearchNotes(query, limit, spaceId)
    : await window.electronAPI.searchNotes(query, limit, spaceId);

  const spaceNameById = new Map(spaces.map((s) => [s.id, s.name]));
  const results = notes.map((note) => ({
    id: note.id,
    title: note.title,
    date: note.created_at,
    type: note.note_type,
    space: spaceNameById.get(note.space_id) ?? null,
    content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
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
  spaces: SpaceItem[]
): Promise<ToolResult> {
  const { NotesService } = await import("../../services/NotesService.js");
  // No space → all accessible spaces; team space → that team only (membership
  // is server-enforced); private space → the personal-only default.
  const teamId = space?.kind === "team" ? (space.cloud_team_id ?? undefined) : undefined;
  const scope = space ? undefined : ("all" as const);
  const { notes: cloudNotes } = await NotesService.search(query, limit, scope, teamId);

  const spaceNameByTeamId = new Map(
    spaces.filter((s) => s.cloud_team_id).map((s) => [s.cloud_team_id!, s.name])
  );
  const privateSpaceName = spaces.find((s) => s.kind === "private")?.name ?? null;
  const results = cloudNotes.map((cn) => ({
    id: cn.client_note_id ? parseInt(cn.client_note_id, 10) : null,
    title: cn.title,
    date: cn.created_at,
    type: cn.note_type,
    score: cn.score,
    space: cn.team_id ? (spaceNameByTeamId.get(cn.team_id) ?? null) : privateSpaceName,
    content: (cn.enhanced_content || cn.content).slice(0, MAX_CONTENT_LENGTH),
  }));

  return {
    success: true,
    data: results,
    displayText: summaryText(results.length, query, space, true),
  };
}
