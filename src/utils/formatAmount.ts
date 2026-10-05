const FALLBACK_CURRENCY = "USD";

export function formatAmount(
  cents: number | null | undefined,
  currency: string | null | undefined
): string {
  const amount = typeof cents === "number" && Number.isFinite(cents) ? cents / 100 : 0;
  const trimmed = typeof currency === "string" ? currency.trim() : "";
  const code = trimmed === "" ? FALLBACK_CURRENCY : trimmed.toUpperCase();
  try {
    return amount.toLocaleString(undefined, { style: "currency", currency: code });
  } catch {
    // Malformed currency codes make toLocaleString throw; fall back instead of crashing the render.
    return amount.toLocaleString(undefined, { style: "currency", currency: FALLBACK_CURRENCY });
  }
}
