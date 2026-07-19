export interface GoogleCalendar {
  id: string;
  summary: string;
  description: string | null;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
}

export interface MicrosoftCalendar {
  id: string;
  summary: string;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
  sync_token_expires_at: number | null;
}

export interface AppleCalendar {
  id: string;
  title: string;
  color: string | null;
  source_name: string | null;
  is_selected: number;
}

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
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted" | null;
  self: boolean;
}

export interface Contact {
  email: string;
  display_name: string | null;
}
