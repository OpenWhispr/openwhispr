import {
  useRef,
  useMemo,
  useCallback,
  type ReactNode,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { cn } from "../lib/utils";

function applyChange(ta: HTMLTextAreaElement, start: number, end: number, insert: string) {
  ta.focus();
  ta.setSelectionRange(start, end);
  document.execCommand("insertText", false, insert);
}

const BULLET_RE = /^(\s*)([-*]) $/;
const BULLET_CONTENT_RE = /^(\s*)([-*]) (.+)$/;
const NUM_RE = /^(\s*)(\d+)\. $/;
const NUM_CONTENT_RE = /^(\s*)(\d+)\. (.+)$/;

interface MarkdownTextareaProps {
  value: string;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onSelect?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

const SYN = "text-foreground/25";
const BULLETS = ["•", "◦", "▸"];
const RE_INLINE_MD = /(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)/g;

function bulletChar(indent: string) {
  const level = Math.floor(indent.length / 2);
  return BULLETS[Math.min(level, BULLETS.length - 1)];
}

function parseInline(text: string, lineKey: number): ReactNode[] {
  if (!text) return [];

  const tokens: ReactNode[] = [];
  RE_INLINE_MD.lastIndex = 0;
  let lastIdx = 0;
  let mi = 0;
  let m: RegExpExecArray | null;

  while ((m = RE_INLINE_MD.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push(text.slice(lastIdx, m.index));
    const k = `${lineKey}-${mi++}`;

    if (m[1]) {
      tokens.push(
        <span key={k}>
          <span className={SYN}>{"***"}</span>
          <span className="font-semibold italic">{m[2]}</span>
          <span className={SYN}>{"***"}</span>
        </span>
      );
    } else if (m[3]) {
      tokens.push(
        <span key={k}>
          <span className={SYN}>{"**"}</span>
          <span className="font-semibold">{m[4]}</span>
          <span className={SYN}>{"**"}</span>
        </span>
      );
    } else if (m[5]) {
      tokens.push(
        <span key={k}>
          <span className={SYN}>{"*"}</span>
          <span className="italic">{m[6]}</span>
          <span className={SYN}>{"*"}</span>
        </span>
      );
    } else if (m[7]) {
      tokens.push(
        <span key={k}>
          <span className={SYN}>{"`"}</span>
          <span className="bg-foreground/[0.04] dark:bg-white/[0.06] rounded-sm px-px">{m[8]}</span>
          <span className={SYN}>{"`"}</span>
        </span>
      );
    }

    lastIdx = m.index + m[0].length;
  }

  if (lastIdx < text.length) tokens.push(text.slice(lastIdx));
  return tokens;
}

function renderOverlay(text: string): ReactNode[] {
  if (!text) return [];

  const lines = text.split("\n");
  const out: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push("\n");

    const line = lines[i];
    if (!line) continue;

    // Header
    const hm = line.match(/^(#{1,3})\s/);
    if (hm) {
      const n = hm[1].length;
      out.push(
        <span key={`l${i}`} className="font-bold">
          <span className={SYN}>{line.slice(0, n + 1)}</span>
          {parseInline(line.slice(n + 1), i)}
        </span>
      );
      continue;
    }

    // Bullet list: `- item` or `* item` (with optional indent)
    const bm = line.match(/^(\s*)([-*])( )/);
    if (bm) {
      const indent = bm[1];
      const marker = bm[2];
      const p = bm[0].length;
      const content = line.slice(p);
      out.push(
        <span key={`l${i}`}>
          {indent}
          <span className="relative">
            <span className="invisible">{marker}</span>
            <span className="absolute left-0 text-foreground/40">{bulletChar(indent)}</span>
          </span>{" "}
          {parseInline(content, i)}
        </span>
      );
      continue;
    }

    // Numbered list: `1. item` (with optional indent)
    const nm = line.match(/^(\s*)(\d+)(\.)(  ?)/);
    if (nm) {
      const indent = nm[1];
      const num = nm[2];
      const dot = nm[3];
      const space = nm[4];
      const p = nm[0].length;
      const content = line.slice(p);
      out.push(
        <span key={`l${i}`}>
          {indent}
          <span className="text-foreground/45">{num}</span>
          <span className={SYN}>{dot}</span>
          {space}
          {parseInline(content, i)}
        </span>
      );
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      out.push(
        <span key={`l${i}`}>
          <span className={SYN}>{"> "}</span>
          {parseInline(line.slice(2), i)}
        </span>
      );
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      out.push(
        <span key={`l${i}`} className={SYN}>
          {line}
        </span>
      );
      continue;
    }

    // Regular line
    const inlined = parseInline(line, i);
    if (inlined.length === 1 && typeof inlined[0] === "string") {
      out.push(inlined[0]);
    } else {
      out.push(<span key={`l${i}`}>{inlined}</span>);
    }
  }

  return out;
}

const SHARED = "leading-[1.7] text-sm px-5 py-3 pb-20 whitespace-pre-wrap break-words";

export function MarkdownTextarea({
  value,
  onChange,
  onSelect,
  onBlur,
  placeholder,
  className,
  disabled,
  textareaRef: externalRef,
}: MarkdownTextareaProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const taRef = externalRef || localRef;

  const syncScroll = useCallback(() => {
    if (taRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = taRef.current.scrollTop;
    }
  }, [taRef]);

  const overlay = useMemo(() => renderOverlay(value), [value]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = taRef.current;
      if (!ta) return;

      const { selectionStart: start, selectionEnd: end, value: val } = ta;
      const before = val.slice(0, start);
      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLine = before.slice(lineStart);
      const lineEndIdx = val.indexOf("\n", start);
      const fullLineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
      const hasContentAfter = fullLineEnd > start;

      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // Empty bullet line → remove prefix, exit list
        const emptyBullet = currentLine.match(BULLET_RE);
        if (emptyBullet) {
          e.preventDefault();
          if (hasContentAfter) {
            applyChange(ta, start, end, `\n${emptyBullet[1]}${emptyBullet[2]} `);
          } else {
            applyChange(ta, lineStart, start, "");
          }
          return;
        }

        // Empty numbered line → remove prefix, exit list
        const emptyNum = currentLine.match(NUM_RE);
        if (emptyNum) {
          e.preventDefault();
          if (hasContentAfter) {
            const next = parseInt(emptyNum[2], 10) + 1;
            applyChange(ta, start, end, `\n${emptyNum[1]}${next}. `);
          } else {
            applyChange(ta, lineStart, start, "");
          }
          return;
        }

        // Bullet with content → continue list
        const bullet = currentLine.match(BULLET_CONTENT_RE);
        if (bullet) {
          e.preventDefault();
          applyChange(ta, start, end, `\n${bullet[1]}${bullet[2]} `);
          return;
        }

        // Numbered list with content → continue with next number
        const num = currentLine.match(NUM_CONTENT_RE);
        if (num) {
          e.preventDefault();
          const next = parseInt(num[2], 10) + 1;
          applyChange(ta, start, end, `\n${num[1]}${next}. `);
          return;
        }
      }

      if (e.key === "Tab") {
        // Multi-line selection → indent/outdent all lines
        if (start !== end && val.slice(start, end).includes("\n")) {
          const firstLineStart = val.lastIndexOf("\n", start - 1) + 1;
          const lastLineEndIdx = val.indexOf("\n", end);
          const lastLineEnd = lastLineEndIdx === -1 ? val.length : lastLineEndIdx;
          const block = val.slice(firstLineStart, lastLineEnd);
          const lines = block.split("\n");

          e.preventDefault();
          let newBlock: string;
          if (e.shiftKey) {
            newBlock = lines.map((l) => l.replace(/^ {1,2}/, "")).join("\n");
          } else {
            newBlock = lines.map((l) => "  " + l).join("\n");
          }
          applyChange(ta, firstLineStart, lastLineEnd, newBlock);
          ta.setSelectionRange(firstLineStart, firstLineStart + newBlock.length);
          return;
        }

        // Single line list indent/outdent
        const isBullet = BULLET_RE.test(currentLine) || BULLET_CONTENT_RE.test(currentLine);
        const numMatch = currentLine.match(/^(\s*)(\d+)\. /);

        if (isBullet || numMatch) {
          e.preventDefault();
          if (e.shiftKey) {
            const spaceMatch = currentLine.match(/^ {1,2}/);
            if (spaceMatch) {
              const removed = spaceMatch[0].length;
              applyChange(ta, lineStart, lineStart + removed, "");
              ta.setSelectionRange(start - removed, start - removed);
            }
          } else if (numMatch) {
            const prefixEnd = lineStart + numMatch[1].length + numMatch[2].length;
            applyChange(ta, lineStart, prefixEnd, numMatch[1] + "  1");
            const pos = lineStart + numMatch[1].length + 5;
            ta.setSelectionRange(pos, pos);
          } else {
            applyChange(ta, lineStart, lineStart, "  ");
            ta.setSelectionRange(start + 2, start + 2);
          }
          return;
        }
      }
    },
    [taRef]
  );

  return (
    <div className={cn("relative w-full h-full", className)}>
      <div
        ref={overlayRef}
        className={cn(
          SHARED,
          "absolute inset-0 overflow-hidden pointer-events-none text-foreground/90"
        )}
        aria-hidden="true"
      >
        {value ? overlay : <span className="text-foreground/15">{placeholder}</span>}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={onChange}
        onSelect={onSelect}
        onBlur={onBlur}
        onKeyDown={handleKeyDown}
        onScroll={syncScroll}
        disabled={disabled}
        className={cn(
          SHARED,
          "relative z-[1] w-full h-full bg-transparent! border-none! outline-none! resize-none rounded-none selection:bg-primary/15",
          disabled && "pointer-events-none"
        )}
        style={{
          boxShadow: "none",
          color: "transparent",
          caretColor: "var(--color-foreground)",
          WebkitTextFillColor: "transparent",
        }}
      />
    </div>
  );
}
