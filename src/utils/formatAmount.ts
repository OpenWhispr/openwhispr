export function formatAmount(cents: number, currency: string): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency });
}
