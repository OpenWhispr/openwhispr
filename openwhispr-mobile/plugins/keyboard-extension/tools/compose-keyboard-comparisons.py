"""Puts each of our keyboard screenshots under the matching Apple reference shot.

    python3 -I tools/compose-keyboard-comparisons.py <our screenshots dir> <output dir>

Our screenshots come from tests/run-keyboard-sim-harness.py --screenshots (named
<device>-<layout>-<appearance>-<orientation>-<state>.png). The Apple references are in
docs/keyboard-screenshots/apple-reference; the keyboard is cut out of each (without the system
bar below the keys), scaled to the same width as ours and stacked above it. Uses macOS `sips`
for cropping and scaling and writes PNGs no wider than 1200 px. Standard library only.
"""

import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

MOBILE = Path(__file__).resolve().parents[3]
APPLE = MOBILE / "docs/keyboard-screenshots/apple-reference"

# Where Apple's keyboard sits in its screenshot, in points from the top of the upright screen:
# (screen width, top of the keyboard glass, bottom of the return row plus padding).
APPLE_REGION = {
    ("promax", "portrait"): (440, 596, 880),
    ("se", "portrait"): (375, 396, 667),
    ("promax", "landscape"): (956, 228, 440),
    ("se", "landscape"): (667, 165, 375),
}
# Our state → the Apple shot's state (Apple has no shot for some of ours).
APPLE_STATE = {"rest": "rest", "typing": "typing", "numbers": "numbers", "row-rest": "rest", "row-typing": "typing"}
OUTPUT_WIDTH = {"portrait": 600, "landscape": 1100}


def read_png(path):
    data = path.read_bytes()
    position, chunks = 8, b""
    while position < len(data):
        length, kind = struct.unpack(">I4s", data[position : position + 8])
        body = data[position + 8 : position + 8 + length]
        position += 12 + length
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            chunks += body
    assert depth == 8 and interlace == 0 and colour in (2, 6), (depth, colour, interlace)
    channels = 3 if colour == 2 else 4
    raw = zlib.decompress(chunks)
    stride = width * channels
    rows, previous, offset = [], bytearray(stride), 0
    for _ in range(height):
        kind = raw[offset]
        line = bytearray(raw[offset + 1 : offset + 1 + stride])
        offset += 1 + stride
        if kind == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + (left + previous[i]) // 2) & 255
        elif kind == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = previous[i]
                c = previous[i - channels] if i >= channels else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        previous = line
        # Alpha is dropped: the screenshots are opaque.
        rows.append(bytes(line) if channels == 3 else b"".join(bytes(line[i : i + 3]) for i in range(0, stride, 4)))
    return width, height, rows


def read_bmp(path):
    """(width, rows of RGB bytes, top row first) of an uncompressed 24- or 32-bit bitmap."""
    data = path.read_bytes()
    start = struct.unpack("<I", data[10:14])[0]
    width, height = struct.unpack("<ii", data[18:26])
    depth = struct.unpack("<H", data[28:30])[0]
    assert depth in (24, 32), depth
    step = depth // 8
    stride = (width * step + 3) & ~3
    rows = []
    for index in range(abs(height)):
        line = data[start + index * stride : start + index * stride + width * step]
        # Stored blue, green, red.
        rows.append(b"".join(bytes((line[i + 2], line[i + 1], line[i])) for i in range(0, len(line), step)))
    return width, rows if height < 0 else rows[::-1]


def write_png(path, width, rows):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    raw = b"".join(b"\x00" + row for row in rows)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, len(rows), 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def sips(*arguments):
    subprocess.run(["sips", *map(str, arguments)], check=True, capture_output=True)


def main():
    ours_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    made = 0
    with tempfile.TemporaryDirectory(prefix="keyboard-compare-") as scratch:
        scratch = Path(scratch)
        for ours in sorted(ours_dir.glob("*.png")):
            device, rest = ours.stem.split("-", 1)
            layout = "en-qwertz" if rest.startswith("en-qwertz-") else rest.split("-", 1)[0]
            appearance, orientation, state = rest[len(layout) + 1 :].split("-", 2)
            width = OUTPUT_WIDTH[orientation]
            ours_scaled = scratch / "ours.png"
            sips("--resampleWidth", width, ours, "--out", ours_scaled)
            _, _, ours_rows = read_png(ours_scaled)

            # The nearest reference there is: the same state, else the other of rest and typing,
            # else the light shot (Apple's set has no dark shot of some states).
            wanted = APPLE_STATE.get(state)
            candidates = [
                APPLE / f"{device}-{layout}-{look}-{orientation}-{shot}.png"
                for look in (appearance, "light")
                for shot in (wanted, "rest", "typing")
                if wanted
            ]
            apple = next((path for path in candidates if path.exists()), None)
            rows = []
            if layout != "en-qwertz" and apple is not None:
                # sips converts to an uncompressed bitmap; turning and cropping happen here,
                # since its own crop offsets proved unreliable.
                bitmap = scratch / "apple.bmp"
                sips("-s", "format", "bmp", apple, "--out", bitmap)
                pixel_width, apple_rows = read_bmp(bitmap)
                points, top, bottom = APPLE_REGION[(device, orientation)]
                scale = pixel_width / points
                cropped = scratch / "apple-cropped.png"
                write_png(cropped, pixel_width, apple_rows[round(top * scale) : round(bottom * scale)])
                sips("--resampleWidth", width, cropped, "--out", cropped)
                _, _, rows = read_png(cropped)
                # A dark rule between Apple's (above) and ours (below).
                rows += [bytes([40, 40, 40]) * width] * 6
            write_png(out_dir / ours.name, width, rows + ours_rows)
            made += 1
    print(f"{made} comparison images written to {out_dir}")


if __name__ == "__main__":
    main()
