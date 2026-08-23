export const OPENAI_DIARIZATION_MODEL = "gpt-4o-transcribe-diarize";

type DiarizationRoute = {
  provider?: string;
  endpoint?: string;
  model?: string | null;
};

export function diarizationHost(endpoint: unknown): "mistral" | "openai" | null {
  if (typeof endpoint !== "string") return null;
  try {
    const host = new URL(endpoint).hostname;
    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) return "mistral";
    if (host === "openai.com" || host.endsWith(".openai.com")) return "openai";
  } catch {}
  return null;
}

export function resolveDiarizationTarget(route: DiarizationRoute | null): string | null {
  return route?.provider === "custom" ? diarizationHost(route.endpoint) : (route?.provider ?? null);
}

export function resolveEffectiveDiarizationModel(
  route: DiarizationRoute | null,
  diarize: boolean
): string | null {
  return diarize && resolveDiarizationTarget(route) === "openai"
    ? OPENAI_DIARIZATION_MODEL
    : (route?.model ?? null);
}
