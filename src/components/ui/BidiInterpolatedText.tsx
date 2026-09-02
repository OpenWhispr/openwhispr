import { Fragment, type ReactNode } from "react";

export const BIDI_VALUE_TOKEN = "__OPENWHISPR_BIDI_VALUE__";

interface BidiInterpolatedTextProps {
  text: string;
  value: ReactNode;
  dir?: "ltr" | "rtl" | "auto";
}

/**
 * Keeps a dynamic value isolated without hard-coding where a locale places it.
 * Call i18next with BIDI_VALUE_TOKEN for the relevant interpolation variable,
 * then supply the real value here.
 */
export function BidiInterpolatedText({ text, value, dir = "ltr" }: BidiInterpolatedTextProps) {
  const parts = text.split(BIDI_VALUE_TOKEN);
  if (parts.length === 1) return <>{text}</>;

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && <bdi dir={dir}>{value}</bdi>}
        </Fragment>
      ))}
    </>
  );
}
