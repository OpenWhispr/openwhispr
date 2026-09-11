import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingAudioSettings, MeetingAudioRecording } from "../../types/meetingAudio";
import { resolveAudioSeek } from "../../utils/meetingAudioSeek";
export interface MeetingAudioHandle {
  playSegment(segment: { source: string; timestamp?: number }): void;
}
export const MeetingAudioPanel = forwardRef<
  MeetingAudioHandle,
  { noteId: number; isRecording: boolean }
>(function MeetingAudioPanel({ noteId, isRecording }, ref) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<MeetingAudioSettings>({
    keepOriginalAudio: true,
    retentionDays: 0,
  });
  const [recordings, setRecordings] = useState<MeetingAudioRecording[]>([]);
  const [error, setError] = useState("");
  const [src, setSrc] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    setSrc("");
    setRecordings([]);
    setError("");
    Promise.all([
      window.electronAPI.getMeetingAudioSettings(),
      window.electronAPI.listMeetingAudio(noteId),
    ])
      .then(([config, items]) => {
        if (active) {
          setSettings(config);
          setRecordings(items);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    const saved = window.electronAPI.onMeetingAudioSaved((data) => {
      if (data.noteId === noteId)
        void window.electronAPI
          .listMeetingAudio(noteId)
          .then((items) => {
            if (active) setRecordings(items);
          })
          .catch((e) => {
            if (active) setError(String(e));
          });
    });
    const unsubscribe = window.electronAPI.onMeetingAudioError(({ error }) => setError(error));
    return () => {
      active = false;
      unsubscribe();
      saved();
    };
  }, [noteId, isRecording]);
  const start = (recording: MeetingAudioRecording, source: string, seconds = 0) => {
    setError("");
    const url = "meeting-audio://recording/" + noteId + "/" + recording.id + "/" + source;
    if (src === url && audio.current?.readyState) {
      audio.current.currentTime = seconds;
      void audio.current.play().catch((e) => setError(String(e)));
    } else {
      pendingSeek.current = seconds;
      setSrc(url);
    }
  };
  useImperativeHandle(ref, () => ({
    playSegment(segment) {
      const match = resolveAudioSeek(recordings, segment);
      if (match) start(match.recording, match.track.source, match.seconds);
      else setError(t("notes.audio.noMatchingAudio"));
    },
  }));
  const update = (next: MeetingAudioSettings) => {
    void window.electronAPI
      .setMeetingAudioSettings(next)
      .then(setSettings)
      .catch((e) => setError(String(e)));
  };
  return (
    <section
      className="border-b border-border px-4 py-2 text-xs space-y-2"
      aria-label={t("notes.audio.title")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label>
          <input
            type="checkbox"
            checked={settings.keepOriginalAudio}
            disabled={isRecording}
            onChange={(e) => update({ ...settings, keepOriginalAudio: e.target.checked })}
          />{" "}
          {t("notes.audio.keep")}
        </label>
        <label>
          {t("notes.audio.retention")}{" "}
          <select
            value={settings.retentionDays}
            disabled={isRecording}
            onChange={(e) => update({ ...settings, retentionDays: Number(e.target.value) })}
          >
            <option value={0}>{t("notes.audio.forever")}</option>
            {[7, 30, 90, 365].map((days) => (
              <option key={days} value={days}>
                {t("notes.audio.days", { count: days })}
              </option>
            ))}
          </select>
        </label>
      </div>
      {recordings.map((recording) => (
        <div key={recording.id} className="flex flex-wrap items-center gap-2">
          <span>{new Date(recording.createdAt).toLocaleString()}</span>
          {recording.tracks.map((track) => (
            <span key={track.source} className="inline-flex gap-2">
              <button disabled={isRecording} onClick={() => start(recording, track.source)}>
                {t("notes.audio.play")} {t("notes.audio." + track.source)}
              </button>
              <button
                disabled={isRecording}
                onClick={() =>
                  void window.electronAPI
                    .revealMeetingAudio(noteId, recording.id, track.source)
                    .catch((e) => setError(String(e)))
                }
              >
                {t("notes.audio.reveal")}
              </button>
            </span>
          ))}
          {recording.error && <span role="alert">{recording.error}</span>}
        </div>
      ))}
      {src && (
        <audio
          ref={audio}
          src={src}
          controls
          preload="metadata"
          className="w-full"
          onLoadedMetadata={() => {
            if (audio.current && pendingSeek.current != null) {
              audio.current.currentTime = pendingSeek.current;
              pendingSeek.current = null;
              void audio.current.play().catch((e) => setError(String(e)));
            }
          }}
          onError={() => setError(t("notes.audio.playbackError"))}
        />
      )}
      {!recordings.length && !isRecording && <p>{t("notes.audio.noAudio")}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
});
