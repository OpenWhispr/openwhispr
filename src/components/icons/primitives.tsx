import type { SVGProps } from "react";
import { createIcon } from "./createIcon";

type MarkProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

// Plain geometric marks used as status dots and stop indicators. Nucleo has no
// bare circle or square, and these are simpler drawn by hand than mapped.
function CircleMark({ strokeWidth = 2, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function SquareMark({ strokeWidth = 2, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

// Glyphs Nucleo lacks (the note editor's formatting marks, a slash command),
// drawn to the same 24px grid as the vendored Nucleo outline set (2px stroke,
// round caps, 3–21 bounds).
const glyph = (children: SVGProps<SVGSVGElement>["children"]) =>
  function Glyph({ strokeWidth = 2, ...props }: MarkProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={24}
        height={24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {children}
      </svg>
    );
  };

const listRows = (x: number) => (
  <>
    <path d={`M${x} 6h11`} />
    <path d={`M${x} 12h11`} />
    <path d={`M${x} 18h11`} />
  </>
);

const BoldMark = glyph(
  <>
    <path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z" />
  </>
);

const ItalicMark = glyph(
  <>
    <path d="M10 5h8" />
    <path d="M6 19h8" />
    <path d="M14.5 5l-5 14" />
  </>
);

const StrikethroughMark = glyph(
  <>
    <path d="M4 12h16" />
    <path d="M16.5 8C16.5 6.2 14.5 5 12 5S7.5 6.2 7.5 8c0 1.5 1.3 2.5 3.5 3.2" />
    <path d="M7.5 16c0 1.8 2 3 4.5 3s4.5-1.2 4.5-3c0-.7-.2-1.3-.7-1.8" />
  </>
);

const HeadingMark = glyph(
  <>
    <path d="M6 5v14" />
    <path d="M18 5v14" />
    <path d="M6 12h12" />
  </>
);

const ListMark = glyph(
  <>
    {listRows(9)}
    <circle cx="4.5" cy="6" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.1" fill="currentColor" stroke="none" />
  </>
);

const ListOrderedMark = glyph(
  <>
    {listRows(9)}
    <path d="M3 4.5l1.5-1V8" />
    <path d="M3 14h2.5L3 18h2.5" />
  </>
);

const ListChecksMark = glyph(
  <>
    <path d="M9 7h11" />
    <path d="M9 17h11" />
    <path d="M3 7l1.5 1.5L7 6" />
    <path d="M3 17l1.5 1.5L7 15" />
  </>
);

const QuoteMark = glyph(
  <>
    <path d="M5 5v14" />
    <path d="M11 7h9" />
    <path d="M11 12h9" />
    <path d="M11 17h6" />
  </>
);

const SquareSlashMark = glyph(
  <>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M14.5 7.5l-5 9" />
  </>
);

// Copy, in the same soft-cornered squares as SquareSlash.
const CopyRoundedMark = glyph(
  <>
    <rect x="8.5" y="8.5" width="12.5" height="12.5" rx="3.5" />
    <path d="M15.5 8.5V6.5A3.5 3.5 0 0 0 12 3H6.5A3.5 3.5 0 0 0 3 6.5V12a3.5 3.5 0 0 0 3.5 3.5h2" />
  </>
);

// The docked note chat's pills, drawn from the design's own icons (Lucide's shapes).
const FolderRoundedMark = glyph(
  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
);

const ListEndMark = glyph(
  <>
    <path d="M16 12H3" />
    <path d="M16 6H3" />
    <path d="M10 18H3" />
    <path d="M21 6v10a2 2 0 0 1-2 2h-5" />
    <path d="m16 20-2-2 2-2" />
  </>
);

const TableMark = glyph(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18" />
    <path d="M3 15h18" />
    <path d="M10 10v10" />
  </>
);

// The Dictionary page's "Hide for me": Nucleo has an eye but no crossed-out one,
// so these are the paths of Lucide's eye-off icon (https://lucide.dev), used
// under Lucide's ISC License:
//
//   Copyright (c) 2026 Lucide Icons and Contributors
//
//   Permission to use, copy, modify, and/or distribute this software for any
//   purpose with or without fee is hereby granted, provided that the above
//   copyright notice and this permission notice appear in all copies.
//
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
//   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
//   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
//   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
//   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
const EyeOffMark = glyph(
  <>
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="m2 2 20 20" />
  </>
);

// Settings > Tone & Style, as drawn in the design: a square with a plus and a
// sparkle at its corner.
const SquareSparkleMark = glyph(
  <>
    <path d="M14 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7" />
    <path d="M12 9.5v5M9.5 12h5" />
    <path d="M19 2.5v5M16.5 5h5" />
  </>
);

// The chat's Fork action (Lucide's git-fork shape).
const GitForkMark = glyph(
  <>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </>
);

// The agent window's controls (Lucide's shapes): expand and collapse the
// modal, read an answer aloud, and the "select text" hint.
const MaximizeMark = glyph(
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>
);

const MinimizeMark = glyph(
  <>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </>
);

const VolumeMark = glyph(
  <>
    <path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19.4 18.4a9 9 0 0 0 0-12.8" />
  </>
);

// The question card's submit arrow (Lucide's arrow-up).
const ArrowUpMark = glyph(
  <>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </>
);

// The agent's progress row: Thinking… and Checking answers…, drawn from the
// design's own icons (Lucide's lightbulb and message-circle-question).
const LightbulbMark = glyph(
  <>
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </>
);

const MessageCircleQuestionMark = glyph(
  <>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </>
);

const TextSelectMark = glyph(
  <>
    <path d="M21 6H3" />
    <path d="M10 12H3" />
    <path d="M10 18H3" />
    <path d="M15 12v8" />
    <path d="M13 12h4" />
    <path d="M13 20h4" />
  </>
);

// The skill icon: a tile on two layers. Each layer is its own group, drawn bottom first,
// so skills/SkillIcon.tsx can drop them in one after another.
const SkillStackMark = glyph(
  <>
    <g data-layer="3">
      <path d="M2.5 16.5 12 21.5l9.5-5" />
    </g>
    <g data-layer="2">
      <path d="M2.5 12 12 17l9.5-5" />
    </g>
    <g data-layer="1">
      <path d="M12 2 2.5 7 12 12l9.5-5L12 2z" />
    </g>
  </>
);

// The sidebar's workspace switcher.
const ChevronsUpDownMark = glyph(
  <>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </>
);

export const ChevronsUpDown = createIcon("chevrons-up-down", ChevronsUpDownMark);
export const Circle = createIcon("circle", CircleMark);
export const ArrowUp = createIcon("arrow-up", ArrowUpMark);
export const Square = createIcon("square", SquareMark);
export const SquareSlash = createIcon("square-slash", SquareSlashMark);
export const Bold = createIcon("bold", BoldMark);
export const CopyRounded = createIcon("copy-rounded", CopyRoundedMark);
export const EyeOff = createIcon("eye-off", EyeOffMark);
export const FolderRounded = createIcon("folder-rounded", FolderRoundedMark);
export const GitFork = createIcon("git-fork", GitForkMark);
export const Heading = createIcon("heading", HeadingMark);
export const Maximize = createIcon("maximize", MaximizeMark);
export const MessageCircleQuestion = createIcon(
  "message-circle-question",
  MessageCircleQuestionMark
);
export const Minimize = createIcon("minimize", MinimizeMark);
export const Italic = createIcon("italic", ItalicMark);
export const Lightbulb = createIcon("lightbulb", LightbulbMark);
export const List = createIcon("list", ListMark);
export const ListChecks = createIcon("list-checks", ListChecksMark);
export const ListEnd = createIcon("list-end", ListEndMark);
export const ListOrdered = createIcon("list-ordered", ListOrderedMark);
export const Quote = createIcon("quote", QuoteMark);
export const SkillStack = createIcon("skill-stack", SkillStackMark);
export const Strikethrough = createIcon("strikethrough", StrikethroughMark);
export const Table = createIcon("table", TableMark);
export const SquareSparkle = createIcon("square-sparkle", SquareSparkleMark);
export const TextSelect = createIcon("text-select", TextSelectMark);
export const Volume = createIcon("volume", VolumeMark);
