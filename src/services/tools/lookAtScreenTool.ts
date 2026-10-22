import type { ToolDefinition, ToolResult } from "./ToolRegistry";

/** The vision model's instructions when it reads the screenshot for look_at_screen. */
export const LOOK_AT_SCREEN_PROMPT =
  "You describe a screenshot of the user's screen for an assistant that can't see it. Answer the question from what is visible only, in at most 150 words. Quote visible text exactly. Where text is cut off or hidden behind something, say so; never guess or complete it, and never state causes, names or details that aren't visible.";

/**
 * The screenshot taken with this message, read only on request: a vision
 * model answers the question in text, so the chat's own model keeps the turn
 * and small talk never touches the image.
 */
export function createLookAtScreenTool(
  describe: (question: string) => Promise<string>
): ToolDefinition {
  return {
    name: "look_at_screen",
    description:
      "Look at the screenshot of the user's screen taken with this message, and get a text answer to a question about it.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What you need to know from the screen" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    readOnly: true,
    promptInstruction:
      'A screenshot of the user\'s screen, taken with this message, is available only through look_at_screen. Use it when the request refers to something on screen ("this", "here", "this email", "the error", "my screen") or can\'t be done without it. Never use it for greetings or small talk, and never to read the calendar, notes or email, which have their own tools. Use what it returns as reported; don\'t add details it doesn\'t give.',
    async execute(args): Promise<ToolResult> {
      const answer = (await describe(String(args.question ?? ""))).trim();
      return answer
        ? { success: true, data: { answer }, displayText: "Read the screen." }
        : { success: false, data: null, displayText: "The screen couldn't be read." };
    },
  };
}
