import { jsonSchema } from "ai";
import type { Tool } from "ai";

export interface ToolResult {
  success: boolean;
  data: unknown;
  displayText: string;
}

export interface ToolExecutionContext {
  assertAuthorized(): void;
}

export function assertToolExecutionAuthorized(context?: ToolExecutionContext): void {
  context?.assertAuthorized();
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

  toAISDKFormat(context?: ToolExecutionContext): Record<string, Tool> {
    const result: Record<string, Tool> = {};
    for (const def of this.getAll()) {
      result[def.name] = {
        description: def.description,
        inputSchema: jsonSchema(def.parameters),
        execute: async (args: unknown) => {
          assertToolExecutionAuthorized(context);
          try {
            const toolResult = await def.execute(args as Record<string, unknown>, context);
            assertToolExecutionAuthorized(context);
            return toolResult.success ? toolResult.data : { error: toolResult.displayText };
          } catch (error) {
            // Authorization errors must abort the model loop, not become input
            // that the previous identity's model can reason over.
            assertToolExecutionAuthorized(context);
            return { error: (error as Error).message || "Tool execution failed" };
          }
        },
      } as Tool;
    }
    return result;
  }
}
