import type { ToolDefinition, ToolResult } from "./ToolRegistry";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  useCloudSearch: boolean;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { useCloudSearch } = options;

  return {
    name: "search_notes",
    description: useCloudSearch
      ? "Search the user's notes using semantic search. Understands meaning and context, not just keywords. Returns matching notes with title, date, relevance score, and a preview of content."
      : "Search the user's notes by keyword or phrase. Returns matching notes with title, date, and a preview of content.",
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

      try {
        if (useCloudSearch) {
          return await executeCloudSearch(query, limit);
        }
        return await executeLocalSearch(query, limit);
      } catch (error) {
        if (useCloudSearch) {
          try {
            return await executeLocalSearch(query, limit);
          } catch {
            // Both failed
          }
        }
        return {
          success: false,
          data: null,
          displayText: `Failed to search notes: ${(error as Error).message}`,
        };
      }
    },
  };
}

async function executeLocalSearch(query: string, limit: number): Promise<ToolResult> {
  const notes = await window.electronAPI.searchNotes(query, limit);

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
    displayText: `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}"`,
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
