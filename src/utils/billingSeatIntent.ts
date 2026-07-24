const STORAGE_KEY = "settings.billingSeatIntent";
// An intent is a short-lived handoff from the workspace section to the billing
// section; expire it so an abandoned navigation doesn't resurface weeks later.
const MAX_AGE_MS = 30 * 60 * 1000;

export interface SeatIntent {
  workspaceId: string;
  additionalSeats: number;
  createdAt: number;
}

export function storeSeatIntent(workspaceId: string, additionalSeats: number): void {
  const intent: SeatIntent = { workspaceId, additionalSeats, createdAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
}

export function readSeatIntent(): SeatIntent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const intent = JSON.parse(raw) as Partial<SeatIntent>;
    if (
      typeof intent.workspaceId !== "string" ||
      typeof intent.additionalSeats !== "number" ||
      typeof intent.createdAt !== "number" ||
      Date.now() - intent.createdAt > MAX_AGE_MS
    ) {
      clearSeatIntent();
      return null;
    }
    return intent as SeatIntent;
  } catch {
    return null;
  }
}

export function clearSeatIntent(): void {
  localStorage.removeItem(STORAGE_KEY);
}
