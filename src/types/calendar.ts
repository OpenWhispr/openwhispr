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
}

export interface CalendarConnectionStatus {
  connected: boolean;
  email: string | null;
}
