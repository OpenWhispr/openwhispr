# ADR 001: OpenWhispr is the application backbone

Status: accepted

Keep React and Electron for the cross-platform UI, persistence and orchestration.
Reuse the existing Windows C and macOS Swift helpers. Do not rewrite the shell
in Rust. Introduce or migrate native services only after a reproducible profile
shows an actual latency bottleneck. Compare cold and warm start, capture-to-final
latency, insertion latency, CPU and memory on both platforms before changing runtimes.

ASR produces words. Diarization segments and clusters voices. Identity attaches
names to those clusters. Changing Whisper models does not improve the separate
speaker models by itself.

Participant count includes the local participant. The system-audio track reserves
one slot for the local microphone; a single-mic recording uses the full cap.
Threshold clustering runs first. If it exceeds the cap, rerun the existing sherpa
clustering at the cap. This preserves fewer actual speakers than the expected
number without inventing an identity algorithm. A constrained second pass costs
extra inference time; profile it before replacing the CLI with an embedded API.

Do not log transcript text or voice embeddings in pipeline metrics. Confidence
must be reported unavailable when the engine does not expose it.
