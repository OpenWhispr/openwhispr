export interface MeetingAudioSettings {
  keepOriginalAudio: boolean;
  retentionDays: number;
}
export interface MeetingAudioRecording {
  id: string;
  noteId: number;
  createdAt: number;
  completedAt?: number;
  error?: string | null;
  tracks: Array<{ source: "mic" | "system"; startedAt: number; durationSeconds?: number }>;
}
