import type { InferenceProvider } from "./types";
import { createCliChatModel, type CliStreamError } from "../cliChatModel";
import { cliSeatForProviderId } from "../../../helpers/llmCli/llmCliRouting.js";

// Non-streaming path (dictation agent): runs the CLI through the same IPC stream
// and returns the final text. Dictation cleanup never reaches this provider (D-03).
export const cliSubscriptionProvider: InferenceProvider = {
  id: "cli-subscription",
  async call({ text, model, config, ctx, agentName }) {
    const seat = cliSeatForProviderId(config.provider);
    if (!seat) throw new Error(`Unsupported CLI provider: ${config.provider}`);

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName, config.toneStyle);
    const { stream } = await createCliChatModel(seat, model).doStream({
      prompt: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [{ type: "text", text }] },
      ],
    });

    let result = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") result += value.delta;
      }
    } catch (error) {
      // Same shape the other providers use: a message plus a translatable key.
      const cliError = error as CliStreamError;
      throw Object.assign(new Error(cliError.message), {
        code: cliError.code,
        messageKey: cliError.messageKey ?? undefined,
      });
    }
    if (!result.trim()) {
      throw Object.assign(new Error("The CLI returned no text"), {
        code: "parse-failed",
        messageKey: "llmSubscriptions.errors.parse-failed",
      });
    }
    return result;
  },
};
