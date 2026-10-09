import type { ToolDefinition, ToolExecutionContext, ToolResult } from "./ToolRegistry";
import { resolveFolderId } from "./utils";
import { syncService } from "../SyncService.js";

// The AI SDK runs a step's tool calls concurrently. Edits of one note take
// turns, so the second reads the first's write instead of failing main's check
// that the note is unchanged since this call read it.
const noteLocks = new Map<number, Promise<void>>();

async function lockNote(id: number): Promise<() => void> {
  const previous = noteLocks.get(id) ?? Promise.resolve();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => held);
  noteLocks.set(id, tail);
  await previous;
  return () => {
    release();
    if (noteLocks.get(id) === tail) noteLocks.delete(id);
  };
}

export const updateNoteTool: ToolDefinition = {
  name: "update_note",
  description:
    "Updates a note's title, personal content, AI summary, or folder. Read get_note first to identify the field that contains the text being edited; content and summary are separate documents. Supply only the changed field, never the combined note context or transcript. Before moving to a folder, call list_folders and reuse an existing folder when its topic fits; only pass a new name when nothing existing fits. Use the note ID from context if provided; otherwise search_notes first.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "number",
        description: "The note ID to update",
      },
      title: {
        type: "string",
        description: "New title for the note (optional)",
      },
      content: {
        type: "string",
        description:
          "Complete replacement of the user's personal notes only, not the AI summary or transcript. Omit unless editing this field. Blank strings are ignored; use clear_fields only when the user explicitly asks to clear the entire field.",
      },
      summary: {
        type: "string",
        description:
          "Complete replacement of the saved AI Summary only. Preserve unrelated sections exactly. Omit unless editing this field. Blank strings are ignored; use clear_fields only when the user explicitly asks to clear the entire field.",
      },
      clear_fields: {
        type: "array",
        items: { type: "string", enum: ["content", "summary"] },
        description:
          "Fields to clear entirely, only when explicitly requested by the user. For section removal, supply the remaining text instead. Never infer clear intent from an empty optional field.",
      },
      folder: {
        type: "string",
        description: "Folder name to move the note to. Created automatically if it does not exist.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  readOnly: false,

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<ToolResult> {
    // Models sometimes send the ID as a numeric string, which get_note accepts.
    const id = typeof args.id === "string" && /^\d+$/.test(args.id) ? Number(args.id) : args.id;
    const clearFields = args.clear_fields ?? [];
    const invalid = (argument: string): ToolResult => ({
      success: false,
      data: null,
      displayText: `Invalid note update argument: ${argument}`,
    });
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return invalid("id");
    const invalidField = ["title", "content", "summary", "folder"].find(
      (key) => args[key] != null && typeof args[key] !== "string"
    );
    if (invalidField) return invalid(invalidField);
    if (
      !Array.isArray(clearFields) ||
      clearFields.some((field) => field !== "content" && field !== "summary")
    ) {
      return invalid("clear_fields");
    }
    const title = typeof args.title === "string" && args.title.trim() ? args.title : undefined;
    const folderName =
      typeof args.folder === "string" && args.folder.trim() ? args.folder : undefined;
    const updates: Parameters<typeof window.electronAPI.updateNote>[1] = {};
    const ignoredFields: string[] = [];
    if (title) updates.title = title;
    for (const field of ["content", "summary"] as const) {
      const value = args[field];
      const clear = clearFields.includes(field);
      if (clear && typeof value === "string" && value.trim()) {
        return {
          success: false,
          data: null,
          displayText: `Cannot replace and clear ${field} together`,
        };
      }
      if (clear) updates[field === "summary" ? "enhanced_content" : field] = "";
      else if (typeof value === "string" && value.trim())
        updates[field === "summary" ? "enhanced_content" : field] = value;
      else if (typeof value === "string") ignoredFields.push(field);
    }
    if (!Object.keys(updates).length && !folderName) {
      return {
        success: false,
        data: null,
        displayText:
          "No changes supplied. Blank fields are ignored; use clear_fields only for an explicitly requested whole-field clear.",
      };
    }

    const unlock = await lockNote(id);
    try {
      const note = await window.electronAPI.getNote(id);
      if (context?.signal.aborted) return { success: false, data: null, displayText: "" };
      if (!note || note.deleted_at) {
        return { success: false, data: null, displayText: `Note with ID ${id} not found` };
      }

      let folderCreated = false;
      if (folderName) {
        // Folder resolution stays within the note's space so a move by name
        // never drags the note into another space.
        const resolved = await resolveFolderId(
          folderName,
          { createIfMissing: true },
          note.space_id
        );
        if (resolved.error) {
          return { success: false, data: null, displayText: resolved.error };
        }
        updates.folder_id = resolved.folderId;
        folderCreated = resolved.created;
      }

      if (context?.signal.aborted) return { success: false, data: null, displayText: "" };
      const result = await window.electronAPI.updateNote(
        id,
        {
          ...updates,
          ...(clearFields.length && {
            clear_fields: clearFields.map((field) =>
              field === "summary" ? "enhanced_content" : "content"
            ),
          }),
        },
        {
          undoable: true,
          expected: note,
          turn: context?.messageId,
        }
      );

      if (!result.success) {
        return {
          success: false,
          data: null,
          displayText: `Failed to update note${result.error ? `: ${result.error}` : ""}`,
        };
      }

      syncService.debouncedPush("note", id);

      const suffix = folderCreated ? ` (moved to new folder "${folderName}")` : "";
      return {
        success: true,
        data: {
          id,
          title: title || note.title,
          ignoredFields,
          updatedFields: Object.keys(updates).map((field) =>
            field === "enhanced_content" ? "summary" : field
          ),
        },
        displayText: `Updated note: "${title || note.title}"${suffix}${ignoredFields.length ? `. Ignored blank fields: ${ignoredFields.join(", ")}` : ""}`,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        displayText: `Failed to update note: ${(error as Error).message}`,
      };
    } finally {
      unlock();
    }
  },
};
