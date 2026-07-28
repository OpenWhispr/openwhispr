import { normalizeBaseUrl } from "./src/config/constants.ts";
import { buildAzureTranscriptionUrl, isAzureOpenAIEndpoint } from "./src/utils/urlUtils.ts";

const resolve = (raw, model, useRaw) => {
  const normalized = normalizeBaseUrl(raw);
  if (!isAzureOpenAIEndpoint(normalized)) return "(not azure)";
  return buildAzureTranscriptionUrl(useRaw ? raw.trim() : normalized, model);
};

const inputs = [
  "https://r.openai.azure.com/openai/deployments/my-deploy/audio/transcriptions?api-version=2024-06-01",
  "https://r.openai.azure.com/openai/deployments/my-deploy/audio/transcriptions",
  "https://r.openai.azure.com",
  "https://r.openai.azure.com/?api-version=2024-06-01",
];
for (const raw of inputs) {
  console.log("\nRAW  ", raw);
  console.log("  normalized :", normalizeBaseUrl(raw));
  console.log("  via normalized:", resolve(raw, "whisper-1", false));
  console.log("  via RAW       :", resolve(raw, "whisper-1", true));
}
