import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information. Returns relevant web results with titles, URLs, and article text.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      numResults: {
        type: "number",
        description: "Number of results to return (default 5)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  readOnly: true,

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query as string;
    const numResults = typeof args.numResults === "number" ? args.numResults : 5;

    try {
      const raw = await window.electronAPI.agentWebSearch!(query, numResults);

      // The IPC layer resolves (never rejects) on failure, so an unchecked
      // `raw` would hand the agent a `{ success: false, error }` object framed
      // as search results. Missing/rejected/rate-limited keys are routine now
      // that every user supplies their own.
      if (!raw?.success) {
        return {
          success: false,
          data: null,
          displayText: `Web search failed: ${raw?.error || "unknown error"}`,
        };
      }

      const results = Array.isArray(raw.results)
        ? raw.results.map(
            (r: {
              title?: string;
              url?: string;
              text?: string;
              publishedDate?: string | null;
            }) => ({
              title: r.title || "",
              url: r.url || "",
              text: r.text ? r.text.slice(0, 500) : "",
              publishedDate: r.publishedDate || null,
            })
          )
        : [];

      return {
        success: true,
        data: results,
        displayText: `Found web results for "${query}"`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Web search failed: ${(error as Error).message}`,
      };
    }
  },
};
