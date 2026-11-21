import { useEffect, useState } from "react";
import type { CalendarOAuthConfigured } from "../utils/connectorEligibility";

/** Which calendar OAuth clients this build carries; null until main answers. */
export function useCalendarOAuthConfigured(): CalendarOAuthConfigured | null {
  const [configured, setConfigured] = useState<CalendarOAuthConfigured | null>(null);
  useEffect(() => {
    let live = true;
    void window.electronAPI
      ?.calendarGetOAuthConfigured?.()
      .then((value) => {
        if (live && value) setConfigured(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return configured;
}
