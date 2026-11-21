# Apple keyboard reference screenshots

Taken 2026-11-20 on iOS 26.5 simulators, region en_ZA, Apple keyboards: English (South Africa) QWERTY, German (Germany) QWERTZ – German, Emoji.

- `kbq-SE`: iPhone SE (3rd generation), UDID 261F1F4E-A08E-4EC2-9BE2-E465CDEE0ACB, 375×667 pt, Touch ID
- `kbq-ProMax`: iPhone 17 Pro Max, UDID 4B28D4FE-F5B5-409E-8407-A925CB10A84B, 440×956 pt, Face ID

Names are `<device>-<keyboard>-<appearance>-<orientation>-<state>.png`. "rest" is an empty field; "typing" has "Hel" (English) or "Hal" (German) typed, so the suggestion bar shows candidates. Landscape files are stored upright (2868×1320 and 1334×750).

| Device  | Files                                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SE      | en light portrait rest / typing, en dark portrait typing, en light portrait numbers, en light + dark landscape rest, de light portrait rest / typing, de light landscape typing, emoji light portrait |
| Pro Max | the same set                                                                                                                                                                                          |

`*-openwhispr-current-light-portrait.png` shows today's OpenWhispr keyboard (the dev build installed on 2026-11-20) for comparison.

What the screenshots show about Apple's layout:

- The suggestion bar is always present above the keys, three slots, even in an empty field.
- SE (Touch ID): bottom row is `123 | globe | mic | space | return`, and emoji is reached through the globe key.
- Pro Max (Face ID): bottom row is `123 | emoji | space | return`; globe and mic sit in the system bar below the keyboard.
- Landscape adds a handwriting key on the right of the bottom row, and the suggestion bar spans the full width.

Switching the active Apple keyboard without taps (the globe key only toggles between the last two keyboards):

```bash
U=<udid>
KB="de_DE@sw=QWERTZ-German;hw=Automatic"   # or "en_ZA@sw=QWERTY;hw=Automatic", or "com.gizmolabs.openwhispr.dev.keyboard"
xcrun simctl spawn $U defaults write com.apple.keyboard.preferences KeyboardsCurrentAndNext -array "$KB" "$KB" "en_ZA@sw=QWERTY;hw=Automatic"
xcrun simctl spawn $U defaults write com.apple.keyboard.preferences KeyboardLastUsed "$KB"
```

Then relaunch the host app (for example `xcrun simctl terminate $U com.apple.MobileSMS; xcrun simctl openurl $U "sms:"`) so the keyboard reloads.
