# Orukeet streaming language metadata

Orukeet's optional audio-language detector runs independently while audio is arriving. It emits advisory `language` events after the first three seconds of audio and updates the estimate after six seconds. A `final` message carries the latest completed estimate:

```json
{
  "type": "final",
  "text": "Example transcript.",
  "language": "en",
  "language_confidence": 0.99,
  "language_supported_score": 0.995,
  "language_audio_seconds": 6,
  "language_source": "audio_lid",
  "language_status": "detected"
}
```

The same language fields appear on early messages with `type: "language"`. This is a separate audio classifier, not an output of the ASR decoder. The score is a model confidence score between zero and one, not a calibrated probability of correctness. An early guess can change.

The gateway does not wait for language detection before returning a transcript. Recordings shorter than three seconds, silent audio, detector overload/failure, or a result that is not ready at commit can return `language: null`, `language_confidence: null`, and `language_status: "unknown"`. Older gateways may omit these fields. Unknown must not be interpreted as English or as proof that the language is supported. This detector is not a voice-activity or code-switching detector.

The desktop adapter preserves the optional final metadata as `language`, `languageConfidence`, `languageSupportedScore`, and `languageAudioSeconds` in `dictationRealtimeFinalize()`. The renderer can subscribe to `onDictationRealtimeLanguage(callback)`; like other preload subscriptions, it returns an unsubscribe function. Hints never trigger a transcript or paste. The final estimate is authoritative for that recording. Routing policy remains with the caller; receiving metadata does not itself switch providers.

Orukeet supports these 25 language codes:

`bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk`

Keep the original recording until routing is settled. Prefer the six-second estimate for automatic fallback, and apply a confidence threshold. Do not route from an early low-confidence guess. An explicit user language outside the supported set can use the existing provider directly.

## Short-window evaluation

On 330 human-read FLEURS clips across 33 languages (all 25 supported languages and eight unsupported languages), exact language accuracy was 172/330 (52.1%) at two seconds and 256/330 (77.6%) at three seconds. Among the 315 clips containing a full six seconds, it was 293/315 (93.0%). These are classifier results on read speech, not ASR word accuracy or production calibration.

At a score threshold of 0.90, the two-second estimate caught 28/80 unsupported-language clips and incorrectly flagged 6/250 supported-language clips. At three seconds those counts were 50/80 (62.5%) and 3/250 (1.2%), and at six seconds 69/75 (92%) and 1/240 (0.4%). The deployed first/update windows therefore remain three and six seconds. A two-second guess is too unreliable to recommend for automatic provider routing. Clips without a sufficiently confident result should retain the user's configured provider or language policy.

## Combined supported-language score and opt-in rollout

The preview adds `language_supported_score` to both language hints and the final result. It sums the detector's normalized scores for the 25 languages above; it is not a calibrated probability. The desktop exposes it as `languageSupportedScore`. Zero is valid. Null, absent, non-finite and out-of-range values are unavailable, not evidence of an unsupported language. A group score can still be valid if the top language has no two-letter ISO code.

If no detector pass completed successfully, the preview final contains `language_supported_score: null`; the desktop omits the camelCase field. If the three-second pass completed but the six-second pass did not, the final retains that valid three-second result and reports `language_audio_seconds: 3`.

On an expanded 950-clip FLEURS read-speech panel (38 languages, including Bengali, Urdu, Tamil, Telugu and Marathi), 908 clips had a full six-second window:

| Rule                        | Unsupported caught | Supported wrongly diverted |
| --------------------------- | -----------------: | -------------------------: |
| Top unsupported score ≥0.30 |            311/312 |                     26/596 |
| Top unsupported score ≥0.50 |            305/312 |                     19/596 |
| Top unsupported score ≥0.70 |            276/312 |                     14/596 |
| Top unsupported score ≥0.90 |            248/312 |                      4/596 |
| Supported total ≤0.30       |            312/312 |                     19/596 |
| Supported total ≤0.10       |            310/312 |                      6/596 |

These are diagnostic results on read speech, not production error rates. The group rule is independent of the top label. Both proposed group cutoffs caught all 121 eligible clips in the five added languages. Those languages are included in the detector's 107-label vocabulary; this does not validate languages outside that vocabulary or code-switching.

The 3.2% is **19 of 596 supported-language test clips**, not 3.2% of all traffic. The earlier 0.4% was 1 of 240 supported clips on a smaller panel using the stricter top-score ≥0.90 rule. On this expanded six-second panel, that same strict rule diverted 4/596 (0.7%). Both the panel and the routing rule changed; the two headline percentages are not a like-for-like model regression.

For the expanded panel's three-second windows (325 unsupported and 625 supported clips):

| Rule                        | Unsupported caught | Supported wrongly diverted |
| --------------------------- | -----------------: | -------------------------: |
| Top unsupported score ≥0.30 |            300/325 |                     72/625 |
| Top unsupported score ≥0.50 |            277/325 |                     40/625 |
| Top unsupported score ≥0.70 |            238/325 |                     24/625 |
| Top unsupported score ≥0.90 |            174/325 |                      8/625 |
| Supported total ≤0.30       |            317/325 |                     76/625 |
| Supported total ≤0.10       |            294/325 |                     26/625 |

The six-second group cutoffs produce too many false fallbacks at three seconds. The implementation leaves that window on the existing rule.

The new routing policy is off by default. The authenticated `/api/stt-config` response can set `orukeetLanguageRouting` for a test cohort:

| Value                            | Behavior                                         |
| -------------------------------- | ------------------------------------------------ |
| Absent, `"off"`, or unrecognized | Existing top-label rule; no comparison event     |
| `"shadow"`                       | Existing routing; log both group-score decisions |
| `"supported-0.30"`               | Use supported total ≤0.30 when eligible          |
| `"supported-0.10"`               | Use supported total ≤0.10 when eligible          |

Eligibility requires Auto language, a valid final supported score, and `languageAudioSeconds >= 6`. Explicit language choices and BYOK behavior stay unchanged. Missing scores or shorter analyzed windows use the existing rule. The retained recording and existing Cloud fallback handle the actual re-transcription; failure never pastes the rejected Orukeet transcript or performs cleanup twice.

A recording lasting six seconds does not guarantee a completed six-second detector pass. For example, a paced 6.1-second recording finalized with the three-second estimate during validation. Never substitute recording duration for `languageAudioSeconds`, or wait for detection to complete before finalizing.

### Preview endpoint

The authenticated test base URL is:

`https://orukeet.gizmovoice.ai/preview/language-routing`

It runs in US West and shares the existing ASR worker. Production's base URL stays unchanged. Use the existing service key **on the backend only** to mint a token at `POST /v1/client-token` under the preview base. Keep the current `account_id` and `socket_role` mint body and account/quota checks. The returned token is single-use and expires after 60 seconds.

For an allowlisted test account, the Cloud session response should return:

- `baseUrl`: `https://orukeet.gizmovoice.ai/preview/language-routing`
- `websocketUrl`: `wss://orukeet.gizmovoice.ai/preview/language-routing/v1/audio/transcriptions/stream`
- The existing token, protocol, model and expiry fields unchanged.

The desktop accepts this exact URL pair alongside production. It rejects other hosts, arbitrary paths, query parameters and mismatched pairs. Use a build containing this change for managed preview sessions. No service key belongs in the renderer or session response.

For a direct operator test, load the existing key into `ORUKEET_SERVICE_KEY` using your secret manager. Optionally set `ORUKEET_ACCOUNT_ID` to exercise an account-scoped session. Convert a recording to raw PCM and replay it at microphone speed:

```sh
ffmpeg -i recording.wav -ar 16000 -ac 1 -f s16le recording.pcm
node scripts/preview-orukeet-language.cjs recording.pcm
```

This uses the desktop streaming adapter and prints only scores, analyzed duration, transcript length and timing. It does not save or print the transcript. Use recordings you have permission to test. The preview is an internal evaluation route, not a throughput benchmark or production rollout.

### Comparison logs and validation

Opt-in managed dictations emit one `Orukeet language routing comparison` event through the existing application logger, at its normal info level. The event contains only allowlisted scores, analyzed duration, a validated language code and routing decisions. It contains no transcript, audio, token or account identifier. Comparison logging adds no detector call or request on the finalization path; existing application log retention/settings apply.

Export comparison events as JSONL and run:

```sh
node scripts/summarize-orukeet-language-routing.cjs comparison-events.jsonl
```

The script accepts application log records with `meta`, or the comparison object itself. It reports eligible counts and disagreements. Accuracy needs a reference: a reviewer may add `expectedSupported: true` or `false` to the outer JSON object after checking the actual recording/language. Without reference labels, the script does not calculate a false-fallback rate or recall from the detector's own guess. Do not include recordings or transcripts in the exported comparison file.

Start with `shadow` for internal testers and collect real dictation, including the reported failure, noise, short recordings and language switching. Review cases where the rules disagree, and supported-language examples even when they agree. Then choose a cutoff and enable it for the test cohort before expanding it.

### Rollback

Set `orukeetLanguageRouting` to `"off"` or remove it from `/api/stt-config`, and restore the production URL pair in the session endpoint. While an experiment is enabled, config expires after 30 seconds and refreshes at the next normal config check; restarting the app refreshes it immediately. Normal config retains its existing 15-minute TTL. No client rebuild is needed to roll back this flag.

The preview also has an operator-side admission switch that can reject new preview requests immediately while existing recordings finish. It does not change production routing. Server operators should use the deployment handoff's rollback command rather than editing the shared production URL map manually.
