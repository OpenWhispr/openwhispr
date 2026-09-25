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

// The note editor's formatting glyphs, drawn to the same 24px grid as the
// vendored Nucleo outline set (2px stroke, round caps, 3–21 bounds).
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
export const Bold = createIcon("bold", BoldMark);
export const Heading = createIcon("heading", HeadingMark);
export const Italic = createIcon("italic", ItalicMark);
export const List = createIcon("list", ListMark);
export const ListChecks = createIcon("list-checks", ListChecksMark);
export const ListOrdered = createIcon("list-ordered", ListOrderedMark);
export const Quote = createIcon("quote", QuoteMark);
export const Strikethrough = createIcon("strikethrough", StrikethroughMark);
export const Table = createIcon("table", TableMark);
