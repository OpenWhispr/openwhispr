const FALLBACK_CURRENCY = "USD";

// Stripe uses whole units for these currencies. ISK and UGX still use hundredths
// in the API for compatibility. See https://docs.stripe.com/currencies#special-cases.
const ZERO_DECIMAL_CHARGE_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export function formatAmount(
  minorUnits: number | null | undefined,
  currency: string | null | undefined
): string {
  const trimmed = typeof currency === "string" ? currency.trim() : "";
  const code = trimmed === "" ? FALLBACK_CURRENCY : trimmed.toUpperCase();
  const units = typeof minorUnits === "number" && Number.isFinite(minorUnits) ? minorUnits : 0;
  const amount = ZERO_DECIMAL_CHARGE_CURRENCIES.has(code) ? units : units / 100;
  try {
    return amount.toLocaleString(undefined, { style: "currency", currency: code });
  } catch {
    // Malformed currency codes make toLocaleString throw; fall back instead of crashing the render.
    return amount.toLocaleString(undefined, { style: "currency", currency: FALLBACK_CURRENCY });
  }
}
