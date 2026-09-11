import type { SVGProps } from "react";

export type RefreshOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function RefreshOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: RefreshOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M3.5 2.5V7.5H8.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M20.5 21.5V16.5H15.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M2.49996 12C2.49996 17.2467 6.75325 21.5 12 21.5C15.6185 21.5 18.7646 19.4769 20.3687 16.5L20.2157 16.7729"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M21.5 12C21.5 6.75329 17.2467 2.5 12 2.5C8.38143 2.5 5.23538 4.52315 3.63131 7.5L3.73595 7.311"
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
