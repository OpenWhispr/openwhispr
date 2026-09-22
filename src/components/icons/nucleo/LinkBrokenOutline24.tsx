import type { SVGProps } from "react";

export type LinkBrokenOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function LinkBrokenOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: LinkBrokenOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M17.5 2.47372L17 3.33975"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M7 20.6602L6.5 21.5263"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M21.5263 6.5L20.6603 7"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M3.33972 17L2.4737 17.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M4.79171 11.1557L4.22195 10.5859C2.46459 8.82858 2.46459 5.97934 4.22195 4.22198C5.97931 2.46462 8.82855 2.46462 10.5859 4.22198L14.1214 7.75751C15.8788 9.51487 15.8788 12.3641 14.1214 14.1215C13.9846 14.2583 13.8412 14.3845 13.6921 14.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M10.254 9.54297C10.1243 9.64671 9.99899 9.75867 9.87881 9.87885C8.12145 11.6362 8.12145 14.4855 9.87881 16.2428L13.4143 19.7783C15.1717 21.5357 18.0209 21.5357 19.7783 19.7783C21.5357 18.021 21.5357 15.1717 19.7783 13.4144L19.2154 12.8515"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
