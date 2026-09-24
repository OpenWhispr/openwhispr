import { jsonSchema } from "ai";
import type { Tool, ToolExecutionOptions } from "ai";

export interface ToolResult {
  success: boolean;
  data: unknown;
  displayText: string;
}

/**
 * Per-call context from the chat turn that invoked the tool. Absent when a
 * tool runs outside a chat turn (tests, direct calls).
 */
export interface ToolExecutionContext {
  toolCallId: string;
  /** Aborts when the turn is cancelled or its conversation ends. */
  signal: AbortSignal;
  /** Tells the chat surface an approval card needs the user's attention. */
  onApprovalRequested: () => void;
  /**
   * The turn's answer must stay in the chat surface instead of being pasted or
   * copied at the user's caret: the tool opened something outside the app,
   * put user content on the clipboard, or needs the user to answer.
   */
  onHoldDelivery: () => void;
  /**
   * Counts one use of `key` in this turn and reports whether it stays within
   * `limit`, so a tool can cap what one turn does (drafts opened, clipboard
   * writes). Synchronous, so tool calls running in parallel can't overshoot.
   */
  claimTurnSlot: (key: string, limit: number) => boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * The AI SDK hands the stream only the model-facing output, so
   * `onDisplayText` receives each call's displayText for its tool step.
   */
  toAISDKFormat(
    createContext?: (toolCallId: string) => ToolExecutionContext,
    onDisplayText?: (toolCallId: string, displayText: string) => void
  ): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    for (const def of this.getAll()) {
      result[def.name] = {
        description: def.description,
        inputSchema: jsonSchema(def.parameters),
        execute: async (args: unknown, options: ToolExecutionOptions) => {
          try {
            const toolResult = await def.execute(
              args as Record<string, unknown>,
              createContext?.(options.toolCallId)
            );
            onDisplayText?.(options.toolCallId, toolResult.displayText);
            return toolResult.success ? toolResult.data : { error: toolResult.displayText };
          } catch (error) {
            return { error: (error as Error).message || "Tool execution failed" };
          }
        },
      } as Tool;
    }
    return result;
  }
}
