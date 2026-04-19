export interface GoogleCalendar {
  id: string;
  summary: string;
  description: string | null;
  background_color: string | null;
  is_selected: number;
  sync_token: string | null;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
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
}

export interface GoogleCalendarAccount {
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

export interface MeetingDetection {
  detectionId: string;
  source: "calendar" | "process" | "audio";
  data: {
    appName?: string;
    durationMs?: number;
    detectedAt: number;
  };
  imminentEvent?: CalendarEvent | null;
}

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  self: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
