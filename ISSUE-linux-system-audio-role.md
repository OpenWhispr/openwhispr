# [Bug]: Linux meeting recording: system audio is pure silence when a Bluetooth headset is the default device (media.role=Communication misroutes capture to the mic)

> Paste into the upstream bug report template. Suggested labels: `bug`, `linux`, `meeting-transcription`.

## Describe the bug

Meeting transcription on Linux captures the local microphone fine but **digital silence from system audio** whenever a Bluetooth headset (HFP profile) is the default audio device. The remote party's voice never appears in the meeting transcript/note.

Root cause is in OpenWhispr itself: `resources/linux-system-audio-helper.c` (`run_pipewire_capture`) sets `media.role=Communication` on its PipeWire capture stream. WirePlumber 0.4.x treats *Communication-role capture streams as telephony mic input* and links them to the **default source (the mic)** — ignoring `target.object` and `stream.capture.sink`. The "system audio" stream therefore records the **headset microphone**, which cannot hear the audio playing in the earcups → silence.

With laptop speakers as default, the mislinked stream records the **built-in mic**, which *acoustically* hears the speakers, so the bug masquerades as "works, poor quality". On newer WirePlumber (0.5.x, node-based policy) `target.object` may be honored despite the role, which is likely why this went unnoticed.

## To Reproduce

Environment: Ubuntu 24.04 · OpenWhispr 1.8.3 (deb) · PipeWire 1.0.5 · WirePlumber 0.4.17 · GNOME. Also confirmed on Fedora/GNOME. Headset: Yealink BH74 (BT, HFP) — BH64 also verified.

1. Pair a BT headset, set it as default sink **and** default source.
2. Start a meeting recording (`Ctrl+Shift+M`) and join a call / play any audio on the laptop.
3. Own voice transcribes; remote participants are missing.
4. Diarization WAVs (`/tmp/ow-diarize-*.wav`) show the captured system-audio track is RMS 0.0000 while logs look healthy: `systemAudioStrategy: 'pipewire-loopback'`, helper emits `{"type":"start"}` and streams bytes.

The helper's stream (via `pw-dump`) shows the wrong link:

```text
node.name           = openwhispr-system-audio
media.class         = Stream/Input/Audio
media.role          = Communication      ← the culprit
stream.capture.sink = true               (ignored under this role)
target.object       = <default sink>     (ignored under this role)
```

Head-to-head experiment (headset = default sink + source, tone played to headset):

| Test | Stream props | Linked to | Audio |
|---|---|---|---|
| helper (original) | `role=Communication` + `capture.sink` + target | `bluez_input.…` (mic) | silence |
| `pw-record` | `role=Communication` + `capture.sink` + target | `bluez_input.…` (mic) | silence |
| `pw-record` | `role=Music` + `capture.sink` (± target) | `bluez_output.…` (sink) | **audible** |
| helper (role patched to `Music`) | `role=Music` + `capture.sink` | `bluez_output.…` (sink) | **audible** |
| `parec -d <sink>.monitor` | PulseAudio API | monitor | **audible** |

Relevant WirePlumber pieces: `policy-bluetooth.lua`, `intended-roles.lua`, `/usr/share/wireplumber/policy.lua.d/50-endpoints-config.lua` (`["Communication"]` endpoint).

## Expected behavior

The system-audio helper should capture the default sink's monitor. In PulseAudio/PipeWire convention `Communication` marks a telephony **voice capture (mic)**; for a sink-monitor loopback capture the correct role is `Music` (or `Movie`/`Production`, or omit the role entirely while keeping `stream.capture.sink=true` + `target.object=<sink>`), which links correctly on WirePlumber 0.4.x.

**Fix (one line)** in `resources/linux-system-audio-helper.c`:

```c
PW_KEY_MEDIA_ROLE, "Music",
```

This affects every WirePlumber 0.4.x user (Ubuntu 24.04, Mint 22, Debian 12-era stacks): their system-audio capture records the default mic instead of the sink monitor. Fix verified on Ubuntu 24.04 and Fedora/GNOME with a Yealink BT headset.

## Desktop

- OS: Ubuntu 24.04 (also Fedora, GNOME) — Linux with PipeWire + WirePlumber 0.4.x
- OpenWhispr: 1.8.3 (deb)

## Additional context

**User workaround until fixed** (re-apply after every update): binary-patch the role string in the shipped ELF — same-length null-padded write, no code/layout change:

```bash
python3 - <<'EOF'
p = '/opt/OpenWhispr/resources/bin/linux-system-audio-helper'
data = bytearray(open(p, 'rb').read())
idx = data.find(b'Communication\x00')
assert idx != -1, 'string not found (already patched or layout changed)'
data[idx:idx+14] = b'Music\x00' + b'\x00'*8
open(p, 'wb').write(bytes(data))
print(f'patched at {hex(idx)}')
EOF
```

**Verification recipe** (no meeting needed):

1. `linux-system-audio-helper probe` → `{"ok":true,...,"source":"pipewire-loopback"}`
2. Play audio, run `linux-system-audio-helper start > /tmp/ow.raw` for a few seconds, kill it; compute RMS of the raw s16le mono 24 kHz PCM → must be > 0.01 (audible).
3. While running, `pw-dump` link check: the `openwhispr-system-audio` node must link **from a sink** (`bluez_output.*` / `alsa_output.*`), not `*_input` (mic).

Side note: in HFP (`headset-head-unit-msbc`) the headset sink runs 16 kHz mono, so expect modest transcription quality for system audio even when capture works — that's a Bluetooth profile limitation, not this bug.
