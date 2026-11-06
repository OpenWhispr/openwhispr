/**
 * find & replace panel (Tiptap FindAndReplace) and the
 * word count shown under the note. Opened with ⌘F or "/Find and replace".
 */
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { FindAndReplacePluginKey } from "@tiptap/extension-find-and-replace";
import { OPEN_FIND_EVENT } from "./events";
import { tb } from "./translate";

/** Re-render on editor transactions, but only while `active`. */
function useEditorTick(editor: Editor, active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const bump = () => setTick((t) => t + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor, active]);
}

export function FindReplacePanel({ editor }: { editor: Editor }) {
  useTranslation(); // re-render on UI language change
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  useEditorTick(editor, open); // a closed panel costs nothing per keystroke

  useEffect(() => {
    // Listen on window, not editor.view.dom: the view may not be mounted yet when
    // this effect runs, and Tiptap throws on editor.view before it is.
    const onOpen = (event: Event) => {
      if ((event as CustomEvent<{ editor?: unknown }>).detail?.editor !== editor) return;
      setOpen(true);
      const selected = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
        " "
      );
      if (selected && selected.length < 100) setTerm(selected);
      setTimeout(() => findRef.current?.select(), 0);
    };
    window.addEventListener(OPEN_FIND_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_FIND_EVENT, onOpen);
  }, [editor]);

  const commands = editor.commands as any;
  useEffect(() => {
    if (!open) return;
    commands.setSearchTerm(term);
    commands.setCaseSensitive(caseSensitive);
  }, [open, term, caseSensitive]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) commands.setReplaceTerm(replacement);
  }, [open, replacement]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    commands.clearSearch?.();
    setOpen(false);
    editor.commands.focus();
  };

  if (!open) return null;
  const plugin: any = FindAndReplacePluginKey.getState(editor.state);
  const total = plugin?.results?.length ?? 0;
  const current = total ? (plugin?.resultIndex ?? 0) + 1 : 0;

  return (
    <div
      className="rte-find-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="rte-find-row">
        <input
          dir="auto"
          ref={findRef}
          value={term}
          placeholder={tb("find.find")}
          aria-label={tb("find.find")}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) commands.goToPreviousResult();
              else commands.goToNextResult();
            }
          }}
        />
        <span className="rte-find-count">{term ? `${current}/${total}` : ""}</span>
        <button
          type="button"
          title={`${tb("find.previous")} (⇧Enter)`}
          aria-label={tb("find.previous")}
          onClick={() => commands.goToPreviousResult()}
        >
          ↑
        </button>
        <button
          type="button"
          title={`${tb("find.next")} (Enter)`}
          aria-label={tb("find.next")}
          onClick={() => commands.goToNextResult()}
        >
          ↓
        </button>
        <button
          type="button"
          title={tb("find.matchCase")}
          aria-label={tb("find.matchCase")}
          aria-pressed={caseSensitive}
          className={caseSensitive ? "is-active" : undefined}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          type="button"
          title={`${tb("find.close")} (Esc)`}
          aria-label={tb("find.close")}
          onClick={close}
        >
          ✕
        </button>
      </div>
      <div className="rte-find-row">
        <input
          dir="auto"
          value={replacement}
          placeholder={tb("find.replace")}
          aria-label={tb("find.replace")}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <button type="button" disabled={!total} onClick={() => commands.replace()}>
          {tb("find.replace")}
        </button>
        <button type="button" disabled={!total} onClick={() => commands.replaceAll()}>
          {tb("find.all")}
        </button>
      </div>
    </div>
  );
}

/**
 * Word / character count, recomputed at most every 400 ms after the document
 * changes (not on every transaction), and only for editable notes.
 */
export function WordCount({ editor }: { editor: Editor }) {
  useTranslation(); // re-render on UI language change
  const [counts, setCounts] = useState<{ words: number; chars: number } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compute = () => {
      const storage: any = (editor.storage as any).characterCount;
      if (!storage || editor.isDestroyed) return;
      setCounts({ words: storage.words(), chars: storage.characters() });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(compute, 400);
    };
    compute();
    editor.on("update", schedule);
    return () => {
      clearTimeout(timer);
      editor.off("update", schedule);
    };
  }, [editor]);
  if (!counts?.words) return null;
  return (
    <div className="rte-word-count" aria-live="off">
      {tb("count", { words: counts.words, chars: counts.chars })}
    </div>
  );
}
