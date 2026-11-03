# Build image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as the build context and network access, then audits the
# result offline, so everything the tests need is installed here. It mirrors the Linux jobs in
# .github/workflows/build-and-notarize.yml (desktop) and .github/workflows/mobile-ci.yml (mobile).
FROM node:24-bookworm

# ELECTRON_OVERRIDE_DIST_PATH keeps require("electron") from throwing without the Electron download (tests
# stub Electron), as in CI.
ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    ELECTRON_OVERRIDE_DIST_PATH=/tmp

# Headers for the Linux native helpers in resources/ (key listener, paste, text monitor, PipeWire audio), and
# CMake for the meeting echo-cancellation helper in native/.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates build-essential cmake pkg-config git python3 \
      libx11-dev libxtst-dev libatspi2.0-dev libglib2.0-dev libpipewire-0.3-dev \
    && rm -rf /var/lib/apt/lists/*

# Scanner contract: the checkout lives inside the image, at /src.
COPY . /src
WORKDIR /src

# Desktop app (Electron main process, preload, React renderer).
# --ignore-scripts skips the Electron download and the rebuild of native modules for Electron's ABI;
# better-sqlite3 is then built for this Node so the database-backed tests run instead of skipping. It also
# skips ffmpeg-static's binary download, so that runs on its own: audio import decodes through it.
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 \
    && node node_modules/ffmpeg-static/install.js

# Native Linux helpers, compiled from source as a release build does. The meeting echo-cancellation helper
# fetches its pinned WebRTC and Abseil sources here, while the network is still up.
RUN npm run compile:linuxkeys \
    && npm run compile:linux-paste \
    && npm run compile:text-monitor \
    && npm run compile:linux-system-audio \
    && node scripts/build-meeting-aec-helper.js

# Mobile app (Expo / React Native). Its iOS native code can't be built on Linux, so only the TypeScript side
# is installed and tested here; the Swift sources are in the checkout for review.
RUN cd openwhispr-mobile \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && node_modules/.bin/patch-package --error-on-fail \
    && npm rebuild better-sqlite3

# Run the suites once so a broken image shows up in the build log, but never fail the build on a test.
# Bounded so a hung test can't eat the scanner's build budget.
RUN timeout 900 npm test > /tmp/desktop-tests.log 2>&1 \
      || echo "WARNING: desktop tests failed or timed out (see /tmp/desktop-tests.log)"; \
    tail -n 15 /tmp/desktop-tests.log
RUN cd openwhispr-mobile \
    && (timeout 900 node_modules/.bin/jest --ci --runInBand > /tmp/mobile-tests.log 2>&1 \
      || echo "WARNING: mobile tests failed or timed out (see /tmp/mobile-tests.log)"); \
    tail -n 15 /tmp/mobile-tests.log
