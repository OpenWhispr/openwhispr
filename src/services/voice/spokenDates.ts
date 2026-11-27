import type { SpokenLanguage } from "./types";

// The call's voice reads "Nov" as a word and "2026-11-19" as digits, and now and then
// misreads "3:00 PM", so an English reply's dates are spelled out, and an hour's ":00"
// dropped, before they are spoken. Other languages' short
// forms ("mar", "sept", "Fr.") are also ordinary words; their replies rely on the
// spoken reply rule asking for names in full.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const ABBREVIATIONS: Record<string, string> = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Sept: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
  Mon: "Monday",
  Tue: "Tuesday",
  Tues: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Thur: "Thursday",
  Thurs: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};
// Names and ordinary words ("Jan said", "Thu Nguyen", "the Sun"): spelled out only beside a
// number or another date, or, for a weekday, after "on".
const ALSO_WORDS = new Set(["Jan", "Jun", "Mar", "Mon", "Thu", "Sat", "Sun"]);

const alternation = (words: string[]) => [...words].sort((a, b) => b.length - a.length).join("|");
const ABBREVIATION_WORDS = alternation(Object.keys(ABBREVIATIONS));
// "Novák" and "Octávio" are names, not "Nov" and "Oct" with letters after them.
const ABBREVIATION = new RegExp(`\\b(${ABBREVIATION_WORDS})(\\.)?(?![\\p{L}\\p{N}])`, "gu");
const DATE_WORD = `(?:${alternation([...Object.keys(ABBREVIATIONS), ...Object.values(ABBREVIATIONS), "May"])})\\b`;
const JOINER = "(?:,|\\s*[-–]|\\s+(?:to|through|and|or))?";
const DATE_FOLLOWS = new RegExp(`^${JOINER}\\s*(?:\\d|${DATE_WORD})`);
// "19 Jan", "19th of Jan", "Fri and Sat"; not "On the 19th, Jan said".
const DATE_PRECEDES = new RegExp(
  `(?:\\d(?:st|nd|rd|th)?(?:\\s+of)?|\\b${DATE_WORD}\\.?${JOINER})\\s*$`
);
const AFTER_ON = /\bon\s+$/;
const ENDS_WITH_ABBREVIATION = new RegExp(`\\b(?:${ABBREVIATION_WORDS})$`);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const ON_THE_HOUR = /\b(\d{1,2}):00(?=\s?[AaPp]\.?\s?[Mm]\b)/g;

/** Whether a period after this text marks an abbreviated date word ("Nov. 19"), not a sentence end. */
export function endsWithDateAbbreviation(text: string): boolean {
  return ENDS_WITH_ABBREVIATION.test(text);
}

/** The text with its dates as a person says them: "Wed, Nov 19 at 3:00 PM" reads "Wednesday, November 19 at 3 PM". */
export function spellOutDates(text: string, language: SpokenLanguage): string {
  if (language !== "en") return text;
  return text
    .replace(ON_THE_HOUR, "$1")
    .replace(ISO_DATE, (date, year: string, month: string, day: string) => {
      const name = MONTHS[Number(month) - 1];
      return name && Number(day) >= 1 && Number(day) <= 31
        ? `${name} ${Number(day)}, ${year}`
        : date;
    })
    .replace(
      ABBREVIATION,
      (
        match: string,
        abbreviation: string,
        period: string | undefined,
        offset: number,
        whole: string
      ) => {
        const before = whole.slice(0, offset);
        const after = whole.slice(offset + match.length);
        const weekdayAfterOn = ABBREVIATIONS[abbreviation].endsWith("day") && AFTER_ON.test(before);
        if (
          ALSO_WORDS.has(abbreviation) &&
          !weekdayAfterOn &&
          !DATE_FOLLOWS.test(after) &&
          !DATE_PRECEDES.test(before)
        ) {
          return match;
        }
        // The period stays only where it also ends the text.
        return ABBREVIATIONS[abbreviation] + (period && !after.trim() ? "." : "");
      }
    );
}
