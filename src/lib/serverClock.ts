// The server's clock, as its last HTTP Date header showed it. Delta pulls ask
// for rows the server stamped after a stored cursor, so the cursor has to be
// a time on the server's clock: one from a device clock running fast sits
// ahead of every row written since, and that device stops receiving them.
//
// The header carries whole seconds and is written before the answer travels,
// so the offset it gives is a little low. That only moves cursors earlier, and
// a pull that reads a row twice applies it once.

let offsetMs: number | null = null;

export function recordServerDate(header: string | null | undefined, receivedAtMs: number): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return;
  // The latest answer wins: a device clock the user corrects must count at once.
  offsetMs = serverMs - receivedAtMs;
}

// How far the server's clock is ahead of this device's, or null before any
// answer carried a Date header.
export function serverClockOffsetMs(): number | null {
  return offsetMs;
}

// A moment on this device's clock, as the server's clock read it. Without a
// Date header yet, the device's own clock is all there is.
export function serverTimeIso(localMs: number): string {
  return new Date(localMs + (offsetMs ?? 0)).toISOString();
}

export function resetServerClockForTests(): void {
  offsetMs = null;
}
