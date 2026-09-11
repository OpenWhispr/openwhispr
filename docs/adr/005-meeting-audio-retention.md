# ADR 005: Persistent meeting audio and transcript playback

Meeting recording originally used temporary PCM solely for speaker processing.
Persistent dictation audio did not cover meetings. New meeting recordings now
retain separate microphone and system WAV tracks under userData/meeting-audio.
24 kHz mono PCM16 source chunks are saved before transcription routing/muting.
The two tracks retain distinct start timestamps and full source samples.

Keep original audio defaults on; retention defaults Forever. Settings are local
and apply to future recordings. Finite retention removes expired sessions on
subsequent recording/list operations. Turning retention off does not delete old
recordings. Playback and reveal-in-folder are available on the note. A bounded
write queue reports disk failures rather than silently dropping audio. WAV headers
are finalized after recording and can be repaired after interrupted shutdown.
Long files use HTTP-style byte ranges through a restricted Electron media scheme,
not a whole-file IPC transfer. The resolver checks note ownership by record note ID,
validates the source and generated session ID, and accepts no arbitrary file path.

Clicking a timestamped transcript segment seeks and plays its source track.
Local ASR timestamps now use the captured chunk start, not inference completion.
Post-meeting diarization restores epoch timestamps after relative-time merging.
Multiple sessions in one note are matched by source and timestamp interval.
The engine provides segment timing, not verified word-level alignment. Historical
notes without original audio cannot be reconstructed. Existing relative timestamps
are not guessed against unrelated recordings.

Limitations: storage is local to each machine. Git synchronizes code, not recordings
or user settings. Simultaneous mic/system playback is not mixed: selecting a segment
plays that segment's source. Physical capture and browser media playback need an
end-to-end Windows/macOS check before a release is labelled validated.
