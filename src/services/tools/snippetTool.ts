import i18n from "../../i18n";
import {
  MAX_SNIPPET_TRIGGER_LENGTH,
  SNIPPET_VARIABLE_NAMES,
  resolveSnippetVariables,
  snippetLocale,
  type Snippet,
} from "../../utils/snippets";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { cleanWordList } from "./dictionaryTool";

export interface SnippetActions {
  getSnippets(): Snippet[];
  setSnippets(snippets: Snippet[]): void;
}

const normalizeTrigger = (trigger: string) => trigger.trim().normalize("NFC").toLowerCase();

const quoteList = (triggers: string[]) => triggers.map((t) => `"${t}"`).join(", ");

const variableList = SNIPPET_VARIABLE_NAMES.map((name) => `{{${name}}}`).join(", ");

/**
 * Snippet bodies stay out of the system prompt: they can run to paragraphs
 * and are only needed when a command names one. The trigger list rides in the
 * tool description so the model knows which snippets exist without a call.
 */
export function createSnippetTool(snippets: Snippet[]): ToolDefinition {
  const triggerList = quoteList(snippets.map((s) => s.trigger));

  return {
    name: "get_snippet",
    description: `Fetch the exact saved text behind one of the user's snippets by its spoken trigger phrase. Any ${variableList} in it comes back filled in, as dictation fills it, and "template" then holds the text as saved. Saved triggers: ${triggerList}.`,
    parameters: {
      type: "object",
      properties: {
        trigger: {
          type: "string",
          description: "The snippet's trigger phrase, exactly as listed in the saved triggers",
        },
      },
      required: ["trigger"],
      additionalProperties: false,
    },
    readOnly: true,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const requested = typeof args.trigger === "string" ? args.trigger : "";
      const wanted = normalizeTrigger(requested);
      const snippet = snippets.find((s) => normalizeTrigger(s.trigger) === wanted);
      if (!snippet) {
        return {
          success: false,
          data: null,
          displayText: `No snippet with trigger "${requested}". Saved triggers: ${triggerList}`,
        };
      }
      // Dictating the trigger fills these variables, so inserting it through
      // the agent must too; the template lets an edit keep them.
      const text = resolveSnippetVariables(snippet.replacement, {
        locale: snippetLocale(i18n.language),
      });
      return {
        success: true,
        data:
          text === snippet.replacement
            ? { trigger: snippet.trigger, text }
            : { trigger: snippet.trigger, text, template: snippet.replacement },
        displayText: `Snippet "${snippet.trigger}"`,
      };
    },
  };
}

function parseSnippetInputs(values: unknown): Snippet[] {
  if (!Array.isArray(values)) return [];
  const byKey = new Map<string, Snippet>();
  for (const value of values) {
    const raw = value as Partial<Snippet> | null;
    const trigger = typeof raw?.trigger === "string" ? raw.trigger.trim() : "";
    const replacement = typeof raw?.replacement === "string" ? raw.replacement.trim() : "";
    if (trigger && trigger.length <= MAX_SNIPPET_TRIGGER_LENGTH && replacement) {
      byKey.set(normalizeTrigger(trigger), { trigger, replacement });
    }
  }
  return [...byKey.values()];
}

export function createUpdateSnippetsTool(actions: SnippetActions): ToolDefinition {
  return {
    name: "update_snippets",
    description: `Create, replace, or delete the user's snippets. A snippet is a short spoken trigger phrase that expands into saved text during dictation. Adding a trigger that already exists replaces its saved text. Saved text may include ${variableList}, filled in each time the snippet is used.`,
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          description: "Snippets to create or replace",
          items: {
            type: "object",
            properties: {
              trigger: { type: "string", description: "Short spoken trigger phrase" },
              replacement: { type: "string", description: "Full text the trigger expands into" },
            },
            required: ["trigger", "replacement"],
            additionalProperties: false,
          },
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "Trigger phrases of snippets to delete",
        },
      },
      additionalProperties: false,
    },
    readOnly: false,

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const current = actions.getSnippets();
      const add = parseSnippetInputs(args.add);
      const addKeys = new Set(add.map((s) => normalizeTrigger(s.trigger)));
      const requestedRemove = cleanWordList(args.remove);
      const removeKeys = new Set(requestedRemove.map(normalizeTrigger));
      const keyOf = (s: Snippet) => normalizeTrigger(s.trigger);

      const removed = current.filter((s) => removeKeys.has(keyOf(s))).map((s) => s.trigger);
      const replaced = current.filter((s) => addKeys.has(keyOf(s))).map((s) => s.trigger);
      const existingKeys = new Set(current.map(keyOf));
      const notFound = requestedRemove.filter((t) => !existingKeys.has(normalizeTrigger(t)));

      if (add.length === 0 && removed.length === 0) {
        return {
          success: false,
          data: null,
          displayText: notFound.length
            ? `No snippet with trigger ${quoteList(notFound)}`
            : `Nothing to change: each snippet needs a trigger of at most ${MAX_SNIPPET_TRIGGER_LENGTH} characters and replacement text`,
        };
      }

      const kept = current.filter((s) => !removeKeys.has(keyOf(s)) && !addKeys.has(keyOf(s)));
      actions.setSnippets([...kept, ...add]);

      const replacedKeys = new Set(replaced.map(normalizeTrigger));
      const added = add.map((s) => s.trigger).filter((t) => !replacedKeys.has(normalizeTrigger(t)));
      const summary = [
        added.length ? `Added ${quoteList(added)}` : "",
        replaced.length ? `Replaced ${quoteList(replaced)}` : "",
        removed.length ? `Removed ${quoteList(removed)}` : "",
      ].filter(Boolean);
      return {
        success: true,
        data: { added, replaced, removed, notFound },
        displayText: summary.join("; "),
      };
    },
  };
}
