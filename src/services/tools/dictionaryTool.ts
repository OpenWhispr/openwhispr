import logger from "../../utils/logger";
import { dictionaryWordKey as key } from "../../utils/snippets";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";

export interface SharedDictionaryWord {
  id: string;
  word: string;
}

export interface DictionaryActions {
  getDictionary(): string[];
  updateDictionary(changes: { add: string[]; remove: string[] }): void;
  // Shared words that apply to the user right now. Async because the shared
  // mirror lives in the main process, behind IPC.
  getSharedWords(): Promise<SharedDictionaryWord[]>;
  // A teammate's word is only ever hidden for the user, never deleted.
  hideSharedWords(ids: string[]): Promise<void>;
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
      "Add words to or remove words from the user's custom dictionary: the names, jargon, and terms transcription must spell exactly. To fix a spelling, remove the old word and add the corrected one in the same call. Words a teammate shared with the team are not the user's to delete: removing one only hides it for the user.",
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
      // Stored spellings by key: the store and SQLite match removals by
      // toLowerCase only, so a removal must name the spelling as stored (an NFD
      // "Café" is not removed by an NFC one).
      const storedByKey = new Map<string, string[]>();
      for (const word of actions.getDictionary()) {
        const wordKey = key(word);
        storedByKey.set(wordKey, [...(storedByKey.get(wordKey) ?? []), word]);
      }
      const sharedEntries = await actions.getSharedWords();
      const sharedIdsByWord = new Map<string, string[]>();
      for (const { id, word } of sharedEntries) {
        const wordKey = key(word);
        sharedIdsByWord.set(wordKey, [...(sharedIdsByWord.get(wordKey) ?? []), id]);
      }
      const inPersonal = (word: string) => storedByKey.has(key(word));
      const inShared = (word: string) => sharedIdsByWord.has(key(word));
      const has = (word: string) => inPersonal(word) || inShared(word);

      const requestedAdd = cleanWordList(args.add);
      const requestedRemove = cleanWordList(args.remove);
      const remove = [
        ...new Set(
          requestedRemove.filter(inPersonal).flatMap((word) => storedByKey.get(key(word)) ?? [])
        ),
      ];
      // Independent of Personal: a shared copy keeps applying after the Personal one goes.
      const hidden = requestedRemove.filter(inShared);
      const notFound = requestedRemove.filter((word) => !has(word));
      // Removals apply first, so a respelling in one call ("Acme" → "ACME") adds
      // the new spelling. Added words always land in Personal; one a teammate
      // still shares counts as present.
      const removedKeys = new Set(requestedRemove.map(key));
      const presentAfterRemovals = (word: string) => has(word) && !removedKeys.has(key(word));
      const add = requestedAdd.filter((word) => !presentAfterRemovals(word));
      const alreadyPresent = requestedAdd.filter(presentAfterRemovals);

      if (add.length === 0 && remove.length === 0 && hidden.length === 0) {
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

      if (hidden.length > 0) {
        const ids = hidden.flatMap((word) => sharedIdsByWord.get(key(word)) ?? []);
        try {
          await actions.hideSharedWords(ids);
        } catch (error) {
          logger.warn(
            "Failed to hide shared dictionary words for the assistant",
            { error: (error as Error)?.message },
            "dictionary"
          );
          const appliedCount = (error as { appliedCount?: number } | null)?.appliedCount ?? 0;
          return {
            success: false,
            data: null,
            displayText:
              `Could not hide ${quoteList(hidden)} from the shared dictionary. ` +
              (appliedCount > 0
                ? "Some were hidden; the rest of the request was not applied"
                : "Nothing was changed"),
          };
        }
      }

      if (add.length > 0 || remove.length > 0) actions.updateDictionary({ add, remove });
      const isHidden = new Set(hidden.map(key));
      const removedAndHidden = remove.filter((word) => isHidden.has(key(word)));
      const removedOnly = remove.filter((word) => !isHidden.has(key(word)));
      const hiddenOnly = hidden.filter((word) => !inPersonal(word));
      const summary = [
        add.length ? `Added ${quoteList(add)}` : "",
        removedOnly.length ? `Removed ${quoteList(removedOnly)}` : "",
        removedAndHidden.length
          ? `Removed ${quoteList(removedAndHidden)} and hid the shared copy for you`
          : "",
        hiddenOnly.length
          ? `Hidden for you ${quoteList(hiddenOnly)} (shared with your team, so it stays for them)`
          : "",
      ].filter(Boolean);
      return {
        success: true,
        data: { added: add, removed: remove, hidden, alreadyPresent, notFound },
        displayText: summary.join("; "),
      };
    },
  };
}
