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
