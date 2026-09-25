# Orukeet streaming language metadata

Orukeet's optional audio-language detector runs independently while audio is arriving. It emits advisory `language` events after the first three seconds of audio and updates the estimate after six seconds. A `final` message carries the latest completed estimate:

```json
{
  "type": "final",
  "text": "Example transcript.",
  "language": "en",
  "language_confidence": 0.99,
  "language_audio_seconds": 6,
  "language_source": "audio_lid",
  "language_status": "detected"
}
```

The same language fields appear on early messages with `type: "language"`. This is a separate audio classifier, not an output of the ASR decoder. The score is a model confidence score between zero and one, not a calibrated probability of correctness. An early guess can change.

The gateway does not wait for language detection before returning a transcript. Recordings shorter than three seconds, silent audio, detector overload/failure, or a result that is not ready at commit can return `language: null`, `language_confidence: null`, and `language_status: "unknown"`. Older gateways may omit these fields. Unknown must not be interpreted as English or as proof that the language is supported. This detector is not a voice-activity or code-switching detector.

The desktop adapter preserves the optional final metadata as `language`, `languageConfidence`, and `languageAudioSeconds` in `dictationRealtimeFinalize()`. The renderer can subscribe to `onDictationRealtimeLanguage(callback)`; like other preload subscriptions, it returns an unsubscribe function. Hints never trigger a transcript or paste. The final estimate is authoritative for that recording. Routing policy remains with the caller; receiving metadata does not itself switch providers.

Orukeet supports these 25 language codes:

`bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk`

Keep the original recording until routing is settled. Prefer the six-second estimate for automatic fallback, and apply a confidence threshold. Do not route from an early low-confidence guess. An explicit user language outside the supported set can use the existing provider directly.

## Short-window evaluation

On 330 human-read FLEURS clips across 33 languages (all 25 supported languages and eight unsupported languages), exact language accuracy was 172/330 (52.1%) at two seconds and 256/330 (77.6%) at three seconds. Among the 315 clips containing a full six seconds, it was 293/315 (93.0%). These are classifier results on read speech, not ASR word accuracy or production calibration.

At a score threshold of 0.90, the two-second estimate caught 28/80 unsupported-language clips and incorrectly flagged 6/250 supported-language clips. At three seconds those counts were 50/80 (62.5%) and 3/250 (1.2%), and at six seconds 69/75 (92%) and 1/240 (0.4%). The deployed first/update windows therefore remain three and six seconds. A two-second guess is too unreliable to recommend for automatic provider routing. Clips without a sufficiently confident result should retain the user's configured provider or language policy.
