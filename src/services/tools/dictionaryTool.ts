import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export interface DictionaryActions {
  getDictionary(): string[];
  updateDictionary(changes: { add: string[]; remove: string[] }): void;
}

export const cleanWordList = (values: unknown): string[] =>
  Array.isArray(values)
    ? [
        ...new Set(
          values
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim())
            .filter(Boolean)
        ),
      ]
    : [];

const quoteList = (words: string[]) => words.map((word) => `"${word}"`).join(", ");

export function createUpdateDictionaryTool(actions: DictionaryActions): ToolDefinition {
  return {
    name: "update_dictionary",
    description:
      "Add words to or remove words from the user's custom dictionary: the names, jargon, and terms transcription must spell exactly. To fix a spelling, remove the old word and add the corrected one in the same call.",
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          items: { type: "string" },
          description: "Words or short phrases to add",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Existing dictionary words to remove",
        },
      },
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const existing = new Set(actions.getDictionary().map((word) => word.toLowerCase()));
      const has = (word: string) => existing.has(word.toLowerCase());
      const requestedAdd = cleanWordList(args.add);
      const requestedRemove = cleanWordList(args.remove);
      const add = requestedAdd.filter((word) => !has(word));
      const alreadyPresent = requestedAdd.filter(has);
      const remove = requestedRemove.filter(has);
      const notFound = requestedRemove.filter((word) => !has(word));

      if (add.length === 0 && remove.length === 0) {
        const reasons = [
          notFound.length ? `Not in the dictionary: ${quoteList(notFound)}` : "",
          alreadyPresent.length ? `Already in the dictionary: ${quoteList(alreadyPresent)}` : "",
        ].filter(Boolean);
        return {
          success: false,
          data: null,
          displayText: reasons.join(". ") || "Nothing to change",
        };
      }

      actions.updateDictionary({ add, remove });
      const summary = [
        add.length ? `Added ${quoteList(add)}` : "",
        remove.length ? `Removed ${quoteList(remove)}` : "",
      ].filter(Boolean);
      return {
        success: true,
        data: { added: add, removed: remove, alreadyPresent, notFound },
        displayText: summary.join("; "),
      };
    },
  };
}
