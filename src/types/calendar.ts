export interface GoogleCalendar {
  id: string;
  summary: string;
  description: string | null;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
}

export type CalendarResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  provider: string;
  summary: string | null;
  start_time: string;
  end_time: string;
  is_all_day: number;
  status: string;
  hangout_link: string | null;
  conference_data: string | null;
  organizer_email: string | null;
  attendees_count: number;
  attendees: string | null;
  availability_status: CalendarAvailabilityStatus;
  self_response_status: CalendarResponseStatus | "unknown";
}

export type CalendarAvailabilityStatus = "free" | "tentative" | "busy" | "unavailable" | "unknown";

export interface CalendarAvailabilityRequest {
  start: string;
  end: string;
  minimumSlotMinutes?: number;
  bufferMinutes?: number;
  maxResults?: number;
}

export interface CalendarAvailabilityInterval {
  start: string;
  end: string;
}

export interface CalendarAvailabilitySlot extends CalendarAvailabilityInterval {
  durationMinutes: number;
}

export interface CalendarAvailabilityResult {
  range: CalendarAvailabilityInterval;
  timezone: string;
  isEntireRangeFree: boolean;
  availableSlots: CalendarAvailabilitySlot[];
  hasMore: boolean;
  coverage: {
    source: "local-calendar-cache";
    lookaheadDays: number;
  };
}

export interface CalendarAccount {
  email: string;
}

export interface CalendarConnectionStatus {
  connected: boolean;
  email: string | null;
}

export interface MeetingDetectionPreferences {
  processDetection: boolean;
  audioDetection: boolean;
}

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: CalendarResponseStatus | null;
  self: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
