import type { SVGProps } from "react";

export type MonitorOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function MonitorOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: MonitorOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M12 17V21"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M7 21H17"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M2 6L2 15C2 16.1046 2.89543 17 4 17L20 17C21.1046 17 22 16.1046 22 15L22 6C22 4.89543 21.1046 4 20 4L19 4L4 4C2.89543 4 2 4.89543 2 6Z"
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
