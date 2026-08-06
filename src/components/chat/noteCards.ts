import type { ToolCallInfo } from "./types";

export interface NoteCardRef {
  noteId: number;
  title: string;
}

const NOTE_TOOLS = new Set(["create_note", "update_note", "get_note"]);
// Search answers can ground on many hits; cap the cards so a broad search
// doesn't bury the answer under a wall of note buttons.
const MAX_SEARCH_CARDS = 5;

function cardFromHit(
  hit: Record<string, unknown>,
  seen: Set<number>,
  fallbackTitle: string
): NoteCardRef | null {
  // Cloud search hits carry null ids for notes with no local row — nothing to
  // open. Non-numeric ids (cloud UUIDs) are equally unopenable locally.
  if (hit.id == null) return null;
  const noteId = Number(hit.id);
  if (!Number.isFinite(noteId) || seen.has(noteId)) return null;
  seen.add(noteId);
  return { noteId, title: typeof hit.title === "string" && hit.title ? hit.title : fallbackTitle };
}

// Note cards rendered under an assistant message: one per note the turn
// created/updated/fetched, plus up to MAX_SEARCH_CARDS notes its searches
// grounded on. Single pass in toolCalls order, deduped across tools.
export function extractNoteCards(
  toolCalls: ToolCallInfo[] | undefined,
  fallbackTitle: string
): NoteCardRef[] {
  if (!toolCalls) return [];
  const cards: NoteCardRef[] = [];
  const seen = new Set<number>();
  let searchCards = 0;

  for (const tc of toolCalls) {
    if (tc.status !== "completed") continue;
    if (NOTE_TOOLS.has(tc.name) && tc.metadata && !Array.isArray(tc.metadata)) {
      if (!tc.metadata.id) continue;
      const noteId = Number(tc.metadata.id);
      if (!Number.isFinite(noteId) || seen.has(noteId)) continue;
      seen.add(noteId);
      const title =
        (tc.metadata.title as string) ||
        tc.result?.replace(/^(Created|Updated|Retrieved) note: "(.+)"$/, "$2") ||
        fallbackTitle;
      cards.push({ noteId, title });
    } else if (tc.name === "search_notes" && Array.isArray(tc.metadata)) {
      for (const hit of tc.metadata) {
        if (searchCards >= MAX_SEARCH_CARDS) break;
        const card = cardFromHit(hit, seen, fallbackTitle);
        if (!card) continue;
        cards.push(card);
        searchCards += 1;
      }
    }
  }
  return cards;
}
