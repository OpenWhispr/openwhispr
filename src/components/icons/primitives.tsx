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

const TextCursorInputMark = glyph(
  <>
    <path d="M5 4h1a3 3 0 0 1 3 3 3 3 0 0 1 3-3h1" />
    <path d="M9 7v10" />
    <path d="M13 20h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H5" />
    <path d="M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1" />
    <path d="M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7" />
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

export const Circle = createIcon("circle", CircleMark);
export const Square = createIcon("square", SquareMark);
export const SquareSlash = createIcon("square-slash", SquareSlashMark);
export const Bold = createIcon("bold", BoldMark);
export const CopyRounded = createIcon("copy-rounded", CopyRoundedMark);
export const FolderRounded = createIcon("folder-rounded", FolderRoundedMark);
export const Heading = createIcon("heading", HeadingMark);
export const Italic = createIcon("italic", ItalicMark);
export const List = createIcon("list", ListMark);
export const ListChecks = createIcon("list-checks", ListChecksMark);
export const ListEnd = createIcon("list-end", ListEndMark);
export const ListOrdered = createIcon("list-ordered", ListOrderedMark);
export const Quote = createIcon("quote", QuoteMark);
export const Strikethrough = createIcon("strikethrough", StrikethroughMark);
export const Table = createIcon("table", TableMark);
export const TextCursorInput = createIcon("text-cursor-input", TextCursorInputMark);
