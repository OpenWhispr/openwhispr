# The 200-word activation milestone

The app sends one AppsFlyer in-app event, `dictated_200_words`, the first time an
install has dictated 200 words. It is how ad measurement tells an install that became
a real user from one that didn't. Code: `src/lib/dictationMilestone.ts`.

## What counts

- The finished dictations the dashboard's `dictation_completed` records
  (`recordDictationCompleted` in `src/lib/productEvents.ts`): the home screen and note
  recorder, and the keyboard. Every transcription provider: on-device, cloud and your
  own key.
- Never onboarding practice, re-transcriptions, chat questions, meetings, file uploads
  or voice-agent instructions.
- Words as heard, before cleanup, from the shared counter (`src/lib/wordCount.ts`). A
  dictation the counter can't count (Chinese, Japanese or Korean without
  `Intl.Segmenter`) adds nothing.
- Per install, from this version on. Earlier dictation and other devices don't count,
  and a reinstall starts again.

## What leaves the phone

Only the event and three values: `transcription_mode` (`local`, `cloud` or `byok`),
`input_source` (`keyboard` or `app`) and `days_since_install_bucket` (`0`, `1`, `2-3`,
`4-7`, `8-14` or `15+`). Never text, audio, word counts or identifiers.

## Consent and delivery

- Nothing is counted while Usage Analytics is off. Turning it off cancels a milestone
  that hasn't been sent yet, for good.
- The event goes through AppsFlyer and is sent on iOS only after the person allows
  tracking. Until then the milestone waits on the device.
- Android has no tracking prompt yet, so there the milestone is counted but not sent.
- The milestone is kept on the device until AppsFlyer's server confirms it, and is
  retried each time the SDK becomes ready, including after a relaunch. It is sent at
  most once per install; in rare cases (the app killed mid-send, or a send slower than
  15 seconds) AppsFlyer may see it twice. If the stored state can't be read, nothing is
  counted or sent that session.
