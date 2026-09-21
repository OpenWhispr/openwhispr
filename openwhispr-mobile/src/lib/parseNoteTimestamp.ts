export function parseNoteTimestamp(updatedAt: string | number | Date | null | undefined): Date {
  if (updatedAt instanceof Date) return updatedAt;
  if (typeof updatedAt === 'number') return new Date(updatedAt);
  if (!updatedAt) return new Date();
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" with a space.
  // Hermes (iOS) rejects that format; convert space → T and ensure UTC marker.
  const iso = updatedAt.replace(' ', 'T');
  const withZ = iso.endsWith('Z') ? iso : iso + 'Z';
  const date = new Date(withZ);
  return isNaN(date.getTime()) ? new Date() : date;
}
