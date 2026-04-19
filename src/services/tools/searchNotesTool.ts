import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  useCloudSearch: boolean;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { useCloudSearch } = options;

  return {
    name: "search_notes",
    description:
      "Search the user's notes using semantic search. Understands meaning and context, not just keywords. Returns matching notes with title, date, relevance score, and a preview of content.",
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
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const limit = typeof args.limit === "number" ? args.limit : 5;

      // Fallback chain: cloud → local semantic (hybrid RRF) → FTS5 keyword
      const strategies: Array<() => Promise<ToolResult>> = [];
      if (useCloudSearch) strategies.push(() => executeCloudSearch(query, limit));
      strategies.push(() => executeLocalSearch(query, limit, true));
      strategies.push(() => executeLocalSearch(query, limit, false));

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

async function executeLocalSearch(
  query: string,
  limit: number,
  semantic: boolean
): Promise<ToolResult> {
  const notes = semantic
    ? await window.electronAPI.semanticSearchNotes(query, limit)
    : await window.electronAPI.searchNotes(query, limit);

  if (notes.length === 0) {
    return {
      success: true,
      data: [],
      displayText: `No notes found for "${query}"`,
    };
  }

  const results = notes.map((note) => ({
    id: note.id,
    title: note.title,
    date: note.created_at,
    type: note.note_type,
    content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
  }));

  return {
    success: true,
    data: results,
    displayText: `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}"${semantic ? " (semantic search)" : ""}`,
  };
}

async function executeCloudSearch(query: string, limit: number): Promise<ToolResult> {
  const { NotesService } = await import("../../services/NotesService.js");
  const { notes: cloudNotes } = await NotesService.search(query, limit);

  if (cloudNotes.length === 0) {
    return {
      success: true,
      data: [],
      displayText: `No notes found for "${query}"`,
    };
  }

  const results = cloudNotes.map((cn) => ({
    id: cn.client_note_id ? parseInt(cn.client_note_id, 10) : null,
    title: cn.title,
    date: cn.created_at,
    type: cn.note_type,
    score: cn.score,
    content: (cn.enhanced_content || cn.content).slice(0, MAX_CONTENT_LENGTH),
  }));

  return {
    success: true,
    data: results,
    displayText: `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}" (semantic search)`,
  };
}
