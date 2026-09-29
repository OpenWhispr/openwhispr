# PiP Tutorial Video Assets

Drop bundled MP4 files into this folder. The Swift module loads them by name via `Bundle.main.url(forResource:withExtension:)`.

## Expected filenames

| Filename               | Used by                     | Step                                             |
| ---------------------- | --------------------------- | ------------------------------------------------ |
| `keyboard-install.mp4` | `KeyboardSetupStep`         | Floats over iOS Settings during keyboard install |
| `keyboard-usage.mp4`   | `GraduationStep` (optional) | Floats over external apps during graduation      |

## Format requirements

- **Container:** MP4 (H.264 video, no audio)
- **Aspect ratio:** Portrait 9:16 (e.g., 480 × 854)
- **Duration:** As short as 1 second — the module re-seeks to start on end-of-playback, so a 1-frame still loops indefinitely without anyone noticing
- **No transparent background:** the PiP system renders the video as a solid rounded rectangle. Design the visual to be self-contained — dark card with rounded corners, on a solid background, no fade-out edges

## Designing the still

The video is shown floating in a rounded rectangle while the user is in another app (e.g., iOS Settings). Treat it like an iOS notification card — high-contrast, scannable in under a second, must read at 1/3 phone width.

Suggested composition for `keyboard-install.mp4`:

- Solid dark fill (`#1C1C1E`, matches the existing in-app `InstructionOverlay`)
- A small "OpenWhispr setup" title at top
- The 5 numbered steps from `KeyboardSetupStep`:
  1. Tap Keyboards
  2. Turn on OpenWhispr
  3. Tap OpenWhispr → enable Allow Full Access
  4. Tap Allow on the popup
  5. Come back here
- Generous padding on all sides — PiP scales aggressively at small sizes

The fastest way to produce one: open the `KeyboardSetupStep` in the simulator (any iOS device), screenshot it (`⌘S` in Simulator), open in Preview, and crop down to **just the dark card**. Export as PNG.

## PNG → 1-frame MP4

Pick whichever you have available.

**With `ffmpeg` (Homebrew: `brew install ffmpeg`):**

```bash
ffmpeg -loop 1 -i steps.png -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -c:v libx264 -c:a aac -t 2 -pix_fmt yuv420p \
  -vf "scale=480:-2,pad=ceil(iw/2)*2:ceil(ih/2)*2" \
  -shortest keyboard-install.mp4
```

The silent AAC audio track is **required** — iOS auto-starts PiP only for media with at least one audio track. A video-only MP4 will bundle and play but won't trigger PiP overlay. The `-t 2` produces a 2-second clip that loops smoothly.

**Without `ffmpeg`** — any free PNG-to-video converter (e.g., cloudconvert.com → "PNG to MP4", duration 1s). Result must be H.264 in an `.mp4` container.

Save the resulting `keyboard-install.mp4` into this folder, then `npx expo prebuild --clean` to pick it up.

## Behavior when missing

If a video file is absent, `PipTutorial.start(name)` returns `false`. Callers fall back to the existing static `InstructionOverlay` (the in-app dark card on `KeyboardSetupStep`). No build break, no runtime error.
