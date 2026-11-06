/**
 * "Linked from" bar shown above a note when other notes
 * link to it with [[its title]]. Click a name to open that note.
 */
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { tb } from "./translate";
import {
  backlinksTo,
  loadNotes,
  onNotesIndexChange,
  openNote,
  type IndexedNote,
} from "./noteLinkIndex";

export function NoteBacklinks({
  noteId,
  title,
  className,
}: {
  noteId: number;
  title: string;
  className?: string;
}) {
  useTranslation(); // re-render on UI language change
  const [links, setLinks] = useState<IndexedNote[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => alive && setLinks(backlinksTo(title || "", noteId));
    // Reuse the cached list (≤15 s old) rather than re-reading every note, with
    // its transcript, on each note switch; refresh when the window regains focus.
    void loadNotes().then(refresh);
    const unsubscribe = onNotesIndexChange(refresh);
    const onFocus = () => void loadNotes();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [noteId, title]);

  if (!links.length) return null;
  return (
    <div className={className}>
      <div className="rte-backlinks">
        <span className="rte-backlinks-label">{tb("backlinks.label")}</span>
        {links.slice(0, 12).map((note) => (
          <button
            key={note.id}
            type="button"
            className="rte-backlink"
            onClick={() => openNote(note.id)}
          >
            {note.title || tb("backlinks.untitled")}
          </button>
        ))}
        {links.length > 12 && (
          <span className="rte-backlinks-label">
            {tb("backlinks.more", { count: links.length - 12 })}
          </span>
        )}
      </div>
    </div>
  );
}
