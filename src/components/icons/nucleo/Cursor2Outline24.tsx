import type { SVGProps } from "react";

export type Cursor2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Cursor2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Cursor2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M4.49997 4.50003L16.5 7.50003L13.4981 10.6698L18.5857 15.7573C19.3668 16.5383 19.3668 17.8047 18.5858 18.5857V18.5857C17.8047 19.3668 16.5384 19.3668 15.7574 18.5858L10.6697 13.4982L7.49994 16.5001L4.49997 4.50003Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
