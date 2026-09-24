import type { SVGProps } from "react";

export type WifiOffOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function WifiOffOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: WifiOffOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M1.42468 9.36218C4.13664 6.66606 7.87374 5 12 5C14.0663 5 16.0351 5.41782 17.8264 6.17359L18.5 5.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M17.7952 11.8494C18.2503 12.1735 18.677 12.5348 19.0711 12.9289"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M21.3881 8.30042C21.8082 8.63796 22.2097 8.99767 22.5909 9.37776"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M4.92896 12.9289C6.7386 11.1193 9.2386 10 12 10C12.6259 10 13.2384 10.0575 13.8325 10.1675L14 10"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M15.5355 16.4645L15.5327 16.4616M15.5327 16.4616L12 19.9943L10.824 18.8183M15.5327 16.4616C15.1412 16.0707 14.6852 15.7444 14.182 15.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M3 21L21 3"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
